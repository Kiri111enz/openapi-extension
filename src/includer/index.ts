import assert from 'assert';
import {resolve, join, dirname} from 'path';
import {mkdir, writeFile} from 'fs/promises';
import {matchFilter} from './utils';

import {dump} from 'js-yaml';

import parsers from './parsers';
import generators from './generators';

import SwaggerParser from '@apidevtools/swagger-parser';
import {JSONSchema6} from 'json-schema';

import {
    LEADING_PAGE_NAME_DEFAULT,
    SPEC_RENDER_MODES,
    SPEC_RENDER_MODE_DEFAULT,
    LEADING_PAGE_MODES,
    LeadingPageMode,
} from './constants';

import {
    IncluderFunctionParams,
    YfmPreset,
    YfmToc,
    YfmTocItem,
    Endpoint,
    Info,
    Refs,
    Specification,
    OpenApiIncluderParams,
    OpenAPISpec,
} from './models';

const INCLUDER_NAME = 'openapi';

class OpenApiIncluderError extends Error {
    path: string;

    constructor(message: string, path: string) {
        super(message);

        this.name = 'OpenApiIncluderError';
        this.path = path;
    }
}

async function includerFunction(params: IncluderFunctionParams<OpenApiIncluderParams>) {
    const {
        readBasePath,
        writeBasePath,
        tocPath,
        vars,
        passedParams: {
            input,
            leadingPage = {},
            filter,
            noindex,
            hidden,
            sandbox,
        },
        index,
    } = params;

    const tocDirPath = dirname(tocPath);

    const contentPath = index === 0
        ? resolve(process.cwd(), writeBasePath, input)
        : resolve(process.cwd(), readBasePath, input);

    const parser = new SwaggerParser();

    try {
        const data = await parser.validate(contentPath, {validate: {spec: true}}) as OpenAPISpec;

        const allRefs: Refs = {};
        for (const file of Object.values(parser.$refs.values())) {
            const schemas = Object.entries(file.components?.schemas || {}).concat(Object.entries(file));
            for (const [refName, schema] of schemas) {
                allRefs[refName] = schema as JSONSchema6;
            }
        }

        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const writePath = join(writeBasePath, tocDirPath, params.item.include!.path);

        await mkdir(writePath, {recursive: true});
        await generateToc({data, writePath, leadingPage, filter, vars});
        await generateContent({data, writePath, leadingPage, filter, noindex, vars, hidden, allRefs, sandbox});
    } catch (error) {
        if (error && !(error instanceof OpenApiIncluderError)) {
            // eslint-disable-next-line no-ex-assign
            error = new OpenApiIncluderError(error.toString(), tocPath);
        }

        throw error;
    }
}

function assertSpecRenderMode(mode: string) {
    const isValid = SPEC_RENDER_MODES.has(mode);

    assert(isValid, `invalid spec display mode ${mode}, available options:${[...SPEC_RENDER_MODES].join(', ')}`);
}

function assertLeadingPageMode(mode: string) {
    const isValid = LEADING_PAGE_MODES.has(mode);

    assert(isValid, `invalid leading page mode ${mode}, available options: ${[...LEADING_PAGE_MODES].join(', ')}`);
}

export type GenerateTocParams = {
    data: OpenAPISpec;
    vars: YfmPreset;
    writePath: string;
    leadingPage: OpenApiIncluderParams['leadingPage'];
    filter: OpenApiIncluderParams['filter'];
};

async function generateToc(params: GenerateTocParams): Promise<void> {
    const {data, writePath, leadingPage, filter, vars} = params;
    const leadingPageName = leadingPage?.name ?? LEADING_PAGE_NAME_DEFAULT;
    const leadingPageMode = leadingPage?.mode ?? LeadingPageMode.Leaf;

    assertLeadingPageMode(leadingPageMode);

    const filterContent = filterUsefullContent(filter, vars);
    const {tags, endpoints} = filterContent(parsers.paths(data, parsers.tags(data)));

    const toc: YfmTocItem & { items: YfmTocItem[] } = {
        name: INCLUDER_NAME,
        items: [],
    };

    tags.forEach((tag, id) => {
        // eslint-disable-next-line no-shadow
        const {name, endpoints: endpointsOfTag} = tag;

        const section: YfmTocItem & { items: YfmTocItem[] } = {
            name,
            items: [],
        };

        section.items = endpointsOfTag.map((endpoint) => handleEndpointRender(endpoint, id));

        addLeadingPage(section, leadingPageMode, leadingPageName, join(id, 'index.md'));

        toc.items.push(section);
    });

    for (const endpoint of endpoints) {
        toc.items.push(handleEndpointRender(endpoint));
    }

    addLeadingPage(toc, leadingPageMode, leadingPageName, 'index.md');

    await mkdir(dirname(writePath), {recursive: true});
    await writeFile(join(writePath, 'toc.yaml'), dump(toc));
}

function addLeadingPage(section: YfmTocItem, mode: LeadingPageMode, name: string, href: string) {
    if (mode === LeadingPageMode.Leaf) {
        (section.items as YfmTocItem[]).unshift({
            name: name,
            href: href,
        });
    } else {
        section.href = href;
    }
}

export type GenerateContentParams = {
    data: OpenAPISpec;
    vars: YfmPreset;
    writePath: string;
    allRefs: Refs;
    leadingPage: OpenApiIncluderParams['leadingPage'];
    filter?: OpenApiIncluderParams['filter'];
    noindex?: OpenApiIncluderParams['noindex'];
    sandbox?: OpenApiIncluderParams['sandbox'];
    hidden?: OpenApiIncluderParams['filter'];
};


type EndpointRoute = {
    path: string;
    content: string;
};

async function generateContent(params: GenerateContentParams): Promise<void> {
    const {
        data,
        writePath,
        allRefs,
        leadingPage,
        filter,
        noindex,
        hidden,
        vars,
        sandbox,
    } = params;
    const filterContent = filterUsefullContent(filter, vars);
    const applyNoindex = matchFilter(noindex || {}, vars, (endpoint) => {
        endpoint.noindex = true;
    });

    const applyHidden = matchFilter(hidden || {}, vars, (endpoint) => {
        endpoint.hidden = true;
    });


    const leadingPageSpecRenderMode = leadingPage?.spec?.renderMode ?? SPEC_RENDER_MODE_DEFAULT;
    assertSpecRenderMode(leadingPageSpecRenderMode);

    const results: EndpointRoute[] = [];

    const info: Info = parsers.info(data);
    let spec = parsers.paths(data, parsers.tags(data));

    if (noindex) {
        applyNoindex(spec);
    }

    if (hidden) {
        applyHidden(spec);
    }

    spec = filterContent(spec);


    const main: string = generators.main({data, info, spec, leadingPageSpecRenderMode});

    results.push({
        path: join(writePath, 'index.md'),
        content: main,
    });

    spec.tags.forEach((tag, id) => {
        const {endpoints} = tag;

        endpoints.forEach((endpoint) => {
            results.push(handleEndpointIncluder(allRefs, endpoint, join(writePath, id), sandbox));
        });

        results.push({
            path: join(writePath, id, 'index.md'),
            content: generators.section(tag),
        });
    });

    for (const endpoint of spec.endpoints) {
        results.push(handleEndpointIncluder(allRefs, endpoint, join(writePath), sandbox));
    }

    for (const {path, content} of results) {
        await mkdir(dirname(path), {recursive: true});
        await writeFile(path, content);
    }
}


function handleEndpointIncluder(
    allRefs: Refs,
    endpoint: Endpoint,
    pathPrefix: string,
    sandbox?: {host?: string},
) {
    const path = join(pathPrefix, mdPath(endpoint));
    const content = generators.endpoint(allRefs, endpoint, sandbox);

    return {path, content};
}

function handleEndpointRender(endpoint: Endpoint, pathPrefix?: string): YfmToc {
    let path = mdPath(endpoint);
    if (pathPrefix) {
        path = join(pathPrefix, path);
    }
    return {
        href: path,
        name: sectionName(endpoint),
        hidden: endpoint.hidden,
    } as YfmToc;
}

function filterUsefullContent(filter: OpenApiIncluderParams['filter'] | undefined, vars: YfmPreset) {
    if (!filter) {
        return (spec: Specification) => spec;
    }

    return (spec: Specification): Specification => {
        const endpointsByTag = new Map();
        const tags = new Map();

        matchFilter(filter, vars, (endpoint, tag) => {
            const tagId = tag?.id ?? null;
            const collection = endpointsByTag.get(tagId) || [];

            collection.push(endpoint);
            endpointsByTag.set(tagId, collection);

            if (tagId !== null) {
                tags.set(tagId, {...tag, endpoints: collection});
            }
        })(spec);

        return {
            ...spec,
            tags,
            endpoints: endpointsByTag.get(null) || [],
        };
    };
}

export function sectionName(e: Endpoint): string {
    return e.summary ?? e.operationId ?? `${e.method} ${e.path}`;
}

export function mdPath(e: Endpoint): string {
    return `${e.id}.md`;
}

export {INCLUDER_NAME as name, includerFunction};

export default {name: INCLUDER_NAME, includerFunction};
