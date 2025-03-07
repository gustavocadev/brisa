import type { BunPlugin } from 'bun';
import type { ESTree } from 'meriyah';
import fs from 'node:fs';
import { join } from 'node:path';
import AST from '@/utils/ast';
import { getConstants } from '@/constants';
import type { ActionInfo } from './get-actions-info';
import getActionsInfo from './get-actions-info';
import { getPurgedBody } from './get-purged-body';
import { logBuildError } from '@/utils/log/log-build';
import { jsx, jsxDEV } from '../ast/constants';

type CompileActionsParams = {
  actionsEntrypoints: string[];
  define: Record<string, string>;
};

const { parseCodeToAST, generateCodeFromAST } = AST('tsx');
const EXPORT_TYPES = new Set([
  'ExportDefaultDeclaration',
  'ExportNamedDeclaration',
]);
const FN_EXPRESSION_TYPES = new Set([
  'ArrowFunctionExpression',
  'FunctionExpression',
]);

export default async function compileActions({
  actionsEntrypoints,
  define,
}: CompileActionsParams) {
  const { BUILD_DIR, IS_PRODUCTION, CONFIG } = getConstants();
  const isNode = CONFIG.output === 'node' && IS_PRODUCTION;
  const rawActionsDir = join(BUILD_DIR, 'actions_raw');
  const external = CONFIG.external ? [...CONFIG.external, 'brisa'] : ['brisa'];
  const res = await Bun.build({
    entrypoints: actionsEntrypoints,
    outdir: join(BUILD_DIR, 'actions'),
    external,
    sourcemap: IS_PRODUCTION ? undefined : 'inline',
    root: rawActionsDir,
    target: isNode ? 'node' : 'bun',
    minify: IS_PRODUCTION,
    splitting: true,
    define,
    plugins: [actionPlugin({ actionsEntrypoints })],
  });

  if (!res.success) {
    logBuildError('Failed to compile actions', res.logs);
  }

  fs.rmSync(rawActionsDir, { recursive: true });

  return res;
}

function actionPlugin({
  actionsEntrypoints,
}: {
  actionsEntrypoints: string[];
}) {
  // These replaces are to fix the regex in Windows
  const filter = new RegExp(
    `(${actionsEntrypoints.join('|').replace(/\\/g, '\\\\')})$`.replace(
      /\//g,
      '[\\\\/]',
    ),
  );

  return {
    name: 'action-plugin',
    setup(build) {
      build.onLoad({ filter }, async ({ path, loader }) => {
        const code = await Bun.file(path).text();
        return { contents: transformToActionCode(code), loader };
      });
    },
  } satisfies BunPlugin;
}

export function transformToActionCode(code: string) {
  let ast = parseCodeToAST(code);

  ast = addResolveActionImport(ast);
  ast = convertToFunctionDeclarations(ast);

  // Order matters, it needs the lastest version of the AST
  const actionsInfo = getActionsInfo(ast);

  for (const actionInfo of actionsInfo) {
    const action = createActionFn(actionInfo);
    ast.body.push(action);
  }

  return generateCodeFromAST(ast);
}

function addResolveActionImport(ast: ESTree.Program): ESTree.Program {
  return {
    ...ast,
    body: [
      {
        type: 'ImportDeclaration',
        source: {
          type: 'Literal',
          value: 'brisa/server',
        },
        specifiers: [
          {
            type: 'ImportSpecifier',
            imported: {
              type: 'Identifier',
              name: 'resolveAction',
            },
            local: {
              type: 'Identifier',
              name: '__resolveAction',
            },
          },
        ],
      },
      ...ast.body,
    ],
  };
}

function convertToFunctionDeclarations(ast: ESTree.Program): ESTree.Program {
  let count = 0;

  const convert = (declaration: any) => {
    // Convert: let Component = () => {} --> function Component() {}
    if (declaration?.type === 'VariableDeclaration') {
      const res = [];

      for (const declarator of declaration.declarations) {
        if (!FN_EXPRESSION_TYPES.has(declarator.init.type)) {
          res.push(declaration);
          break;
        }

        let body = declarator.init.body;

        if (body.type !== 'BlockStatement') {
          body = {
            type: 'BlockStatement',
            body: [
              {
                type: 'ReturnStatement',
                argument: body,
              },
            ],
          };
        }

        res.push({
          type: 'FunctionDeclaration',
          id: declarator.id,
          params: declarator.init.params,
          body,
          async: declarator.init.async,
          generator: declarator.init.generator ?? false,
        });
      }

      return res;
    }

    // Convert: () => {} --> function Component() {}
    if (declaration?.type === 'ArrowFunctionExpression') {
      return [
        {
          type: 'FunctionDeclaration',
          id: {
            type: 'Identifier',
            name: `Component__${count++}__`,
          },
          params: declaration.params,
          body:
            declaration.body.type === 'BlockStatement'
              ? declaration.body
              : {
                  type: 'BlockStatement',
                  body: [
                    {
                      type: 'ReturnStatement',
                      argument: declaration.body,
                    },
                  ],
                },
          async: declaration.async,
          generator: false,
        },
      ];
    }
    return [declaration];
  };

  const body = [];

  for (const node of ast.body) {
    const isExport = EXPORT_TYPES.has(node?.type);
    const isExportWithSpecifiers = isExport && (node as any).specifiers?.length;
    const isExportWithIdentifier =
      isExport && (node as any).declaration?.type === 'Identifier';

    if (!isExportWithSpecifiers && !isExportWithIdentifier) {
      body.push(
        ...(isExport ? convert((node as any).declaration) : convert(node)),
      );
    }
  }

  return { ...ast, body };
}

function createActionFn(info: ActionInfo): ESTree.ExportNamedDeclaration {
  const body = getPurgedBody(info);
  const { params, requestDestructuring, requestParamName } =
    getActionParams(info);
  const FUNCTIONS_TO_IGNORE_AWAIT = new Set([
    requestParamName,
    'console',
    'setTimeout',
    'setInterval',
    'clearTimeout',
    'clearInterval',
  ]);

  if (info.actionFnExpression) {
    let position = 0;

    // There are some cases that exists both, like: onClick={someIdentifier.bind(null, 'foo')}
    if (info.actionIdentifierName) {
      const identifierPosition = body.body.findLastIndex(
        (node) => node.type === 'VariableDeclaration',
      );
      if (identifierPosition !== -1) position = identifierPosition + 1;
    }

    body.body.splice(position, 0, {
      type: 'VariableDeclaration',
      kind: 'const',
      declarations: [
        {
          type: 'VariableDeclarator',
          id: {
            type: 'Identifier',
            name: '__action',
          },
          init: JSON.parse(
            JSON.stringify(info.actionFnExpression!),
            function (key, value) {
              if (
                value?.type === 'CallExpression' &&
                this?.type !== 'AwaitExpression' &&
                !FUNCTIONS_TO_IGNORE_AWAIT.has(value.callee?.object?.name) &&
                !FUNCTIONS_TO_IGNORE_AWAIT.has(
                  value.callee?.object?.object?.name,
                )
              ) {
                return {
                  type: 'CallExpression',
                  callee: {
                    type: 'MemberExpression',
                    object: {
                      type: 'Identifier',
                      name: requestParamName,
                    },
                    computed: false,
                    property: {
                      type: 'Identifier',
                      name: '_p',
                    },
                  },
                  arguments: [value],
                };
              }
              return value;
            },
          ),
        },
      ],
    });
  }

  if (requestDestructuring) {
    body.body.unshift(requestDestructuring);
  }

  // await __action(...req.store.get('__params:actionId'));
  body.body.push(getActionCall(info, requestParamName));

  // await req.waitActionCallPromises('actionId');
  body.body.push(waitActionCallPromises(info.actionId, requestParamName));

  return {
    type: 'ExportNamedDeclaration',
    declaration: {
      type: 'FunctionDeclaration',
      id: {
        type: 'Identifier',
        name: info.actionId,
      },
      params,
      body: wrapWithTypeCatch({ body, info, params, requestParamName }),
      async: true,
      generator: false,
    },
    specifiers: [],
    source: null,
  };
}

function getActionParams(info: ActionInfo) {
  const params = (info.componentFnExpression?.params ?? []).slice();
  let requestParamName = 'req';
  let requestDestructuring;

  // Add props as first param if there's no params
  if (!params.length) {
    params.push({ type: 'ObjectPattern', properties: [] });
  }

  // Add "req" as second param
  if (params.length === 1) {
    params.push({ type: 'Identifier', name: requestParamName });
  } else {
    const currentReq = params[1];

    requestParamName =
      currentReq?.type === 'Identifier' ? currentReq?.name : 'req';
    params[1] = { type: 'Identifier', name: requestParamName };

    if (currentReq.type === 'ObjectPattern') {
      requestDestructuring = {
        type: 'VariableDeclaration',
        kind: 'const',
        declarations: [
          {
            type: 'VariableDeclarator',
            id: {
              type: 'ObjectPattern',
              properties: currentReq.properties.filter(
                (p) =>
                  p.type !== 'RestElement' ||
                  (p as any).argument?.name !== requestParamName,
              ),
            },
            init: {
              type: 'Identifier',
              name: requestParamName,
            },
          },
        ],
      } satisfies ESTree.VariableDeclaration;
    }
  }

  return { params, requestDestructuring, requestParamName };
}

function getActionCall(
  info: ActionInfo,
  requestParamName: string,
): ESTree.ExpressionStatement {
  return {
    type: 'ExpressionStatement',
    expression: {
      type: 'AwaitExpression',
      argument: {
        type: 'CallExpression',
        callee: {
          type: 'Identifier',
          name: info.actionFnExpression
            ? '__action'
            : info.actionIdentifierName,
        },
        arguments: [
          {
            type: 'SpreadElement',
            argument: {
              type: 'CallExpression',
              callee: {
                type: 'MemberExpression',
                object: {
                  type: 'MemberExpression',
                  object: {
                    type: 'Identifier',
                    name: requestParamName,
                  },
                  computed: false,
                  property: {
                    type: 'Identifier',
                    name: 'store',
                  },
                },
                computed: false,
                property: {
                  type: 'Identifier',
                  name: 'get',
                },
              },
              arguments: [
                {
                  type: 'Literal',
                  value: '__params:' + info.actionId,
                },
              ],
            },
          },
        ],
      },
    },
  };
}

function waitActionCallPromises(
  actionId: string,
  requestParamName: string,
): ESTree.ExpressionStatement {
  return {
    type: 'ExpressionStatement',
    expression: {
      type: 'AwaitExpression',
      argument: {
        type: 'CallExpression',
        callee: {
          type: 'MemberExpression',
          object: {
            type: 'Identifier',
            name: requestParamName,
          },
          computed: false,
          property: {
            type: 'Identifier',
            name: '_waitActionCallPromises',
          },
        },
        arguments: [
          {
            type: 'Literal',
            value: actionId,
          },
        ],
      },
    },
  };
}

function wrapWithTypeCatch({
  body,
  info,
  params,
  requestParamName,
}: {
  body: ESTree.BlockStatement;
  info: ActionInfo;
  params: ESTree.FunctionDeclaration['params'];
  requestParamName: string;
}): ESTree.BlockStatement {
  const { IS_PRODUCTION } = getConstants();

  // Remove default values from props, they are not
  // needed to render the component, we need to pass
  // all props as object
  let props = JSON.parse(JSON.stringify(params[0]), (key, value) => {
    if (value?.value?.type === 'AssignmentPattern') {
      return {
        ...value,
        value: value.value.left,
      };
    }
    return value;
  });

  if (props.type === 'Identifier') {
    props = {
      type: 'ObjectPattern',
      properties: [
        {
          type: 'RestElement',
          argument: props,
        },
      ],
    };
  }

  if (props.type === 'ObjectPattern') {
    props.properties.push({
      type: 'RestElement',
      argument: {
        type: 'Identifier',
        name: '__props',
      },
    });
  }

  return {
    ...body,
    body: [
      {
        type: 'TryStatement',
        block: {
          type: 'BlockStatement',
          body: body.body,
        },
        handler: {
          type: 'CatchClause',
          param: {
            type: 'Identifier',
            name: 'error',
          },
          body: {
            type: 'BlockStatement',
            body: [
              {
                type: 'ReturnStatement',
                argument: {
                  type: 'CallExpression',
                  callee: {
                    type: 'Identifier',
                    name: '__resolveAction',
                  },
                  arguments: [
                    {
                      type: 'ObjectExpression',
                      properties: [
                        {
                          type: 'Property',
                          key: {
                            type: 'Identifier',
                            name: 'req',
                          },
                          value: {
                            type: 'Identifier',
                            name: requestParamName,
                          },
                          kind: 'init',
                          computed: false,
                          method: false,
                          shorthand: requestParamName === 'req',
                        },
                        {
                          type: 'Property',
                          key: {
                            type: 'Identifier',
                            name: 'error',
                          },
                          value: {
                            type: 'Identifier',
                            name: 'error',
                          },
                          kind: 'init',
                          computed: false,
                          method: false,
                          shorthand: true,
                        },
                        {
                          type: 'Property',
                          key: {
                            type: 'Identifier',
                            name: 'actionId',
                          },
                          value: {
                            type: 'Literal',
                            value: info.actionId,
                          },
                          kind: 'init',
                          computed: false,
                          method: false,
                          shorthand: false,
                        },
                        {
                          type: 'Property',
                          key: {
                            type: 'Identifier',
                            name: 'component',
                          },
                          value: {
                            type: 'ArrowFunctionExpression',
                            params: [
                              {
                                type: 'Identifier',
                                name: '__props',
                              },
                            ],
                            body: {
                              type: 'CallExpression',
                              callee: {
                                type: 'Identifier',
                                name: IS_PRODUCTION ? jsx : jsxDEV,
                              },
                              arguments: [
                                {
                                  type: 'Identifier',
                                  name:
                                    (
                                      info.componentFnExpression as ESTree.FunctionExpression
                                    )?.id?.name ??
                                    // TODO: Support arrow function names
                                    'Component',
                                },
                                props,
                                ...((IS_PRODUCTION
                                  ? []
                                  : [
                                      {
                                        type: 'Identifier',
                                        name: 'undefined',
                                      },
                                      {
                                        type: 'Literal',
                                        value: false,
                                      },
                                      {
                                        type: 'Identifier',
                                        name: 'undefined',
                                      },
                                      {
                                        type: 'ThisExpression',
                                      },
                                    ]) as any),
                              ],
                            },
                            async: false,
                            expression: true,
                          },
                          kind: 'init',
                          computed: false,
                          method: false,
                          shorthand: false,
                        },
                      ],
                    },
                  ],
                },
              },
            ],
          },
        },
        finalizer: null,
      },
    ],
  };
}
