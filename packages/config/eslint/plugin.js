// Local ESLint rules that enforce BizCost conventions (see docs/ARCHITECTURE.md).

// Tailwind/Uniwind utilities tied to a physical side. Use logical ones instead:
// ms-/me-/ps-/pe-/start-/end-/text-start/text-end/rounded-s/rounded-e/border-s/border-e.
const PHYSICAL_CLASS =
  /(?:^|[\s:"'`])(-?(?:ml|mr|pl|pr|left|right|scroll-ml|scroll-mr|scroll-pl|scroll-pr|rounded-l|rounded-r|rounded-tl|rounded-tr|rounded-bl|rounded-br|border-l|border-r)-\S*|text-left|text-right|float-left|float-right|clear-left|clear-right|rounded-l|rounded-r|rounded-tl|rounded-tr|rounded-bl|rounded-br|border-l|border-r)(?=$|[\s"'`])/

// React Native style props tied to a physical side. Use marginStart/End, paddingStart/End, start/end, ...
const PHYSICAL_STYLE_PROPS = new Set([
  'marginLeft',
  'marginRight',
  'paddingLeft',
  'paddingRight',
  'left',
  'right',
  'borderLeftWidth',
  'borderRightWidth',
  'borderLeftColor',
  'borderRightColor',
  'borderTopLeftRadius',
  'borderTopRightRadius',
  'borderBottomLeftRadius',
  'borderBottomRightRadius',
])

function checkText(context, node, text) {
  const match = PHYSICAL_CLASS.exec(text)
  if (match) {
    context.report({ node, messageId: 'physical', data: { cls: match[1] } })
  }
}

const noPhysicalDirectionClasses = {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow physical-direction utility classes (breaks RTL).' },
    messages: {
      physical:
        '"{{cls}}" is tied to a physical side and breaks Arabic RTL. Use the logical utility (ms-/me-/ps-/pe-/start-/end-/text-start/text-end/rounded-s/e/border-s/e).',
    },
    schema: [],
  },
  create(context) {
    return {
      Literal(node) {
        if (typeof node.value === 'string') checkText(context, node, node.value)
      },
      TemplateElement(node) {
        checkText(context, node, node.value.raw)
      },
    }
  },
}

const noPhysicalStyleProps = {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow physical-direction React Native style props (breaks RTL).' },
    messages: {
      physical:
        '"{{prop}}" is tied to a physical side and breaks Arabic RTL. Use the Start/End variant.',
      textAlign:
        'textAlign "{{value}}" breaks Arabic RTL. Omit it or use the default (start) alignment.',
    },
    schema: [],
  },
  create(context) {
    return {
      Property(node) {
        const key =
          node.key.type === 'Identifier'
            ? node.key.name
            : node.key.type === 'Literal'
              ? node.key.value
              : null
        if (typeof key !== 'string') return
        if (PHYSICAL_STYLE_PROPS.has(key)) {
          context.report({ node: node.key, messageId: 'physical', data: { prop: key } })
        } else if (
          key === 'textAlign' &&
          node.value.type === 'Literal' &&
          (node.value.value === 'left' || node.value.value === 'right')
        ) {
          context.report({
            node: node.value,
            messageId: 'textAlign',
            data: { value: node.value.value },
          })
        }
      },
    }
  },
}

// Tenant context (app.user_id / app.business_id / app.request_id) is set only by withTenantTx()
// (packages/db/src/tenant.ts), transaction-locally. A raw SET/RESET or set_config() elsewhere could
// leave context (or a role) on a pooled connection for the next request.
const RAW_SET = /^\s*(?:set|reset)\s/i
const SET_CONFIG = /\bset_config\s*\(/i
// Calls that take raw SQL text: drizzle sql.raw(), postgres.js .unsafe(), execute()/query().
const RAW_SQL_CALLEES = new Set(['raw', 'unsafe', 'execute', 'query'])

function templateText(node) {
  return node.quasis.map((q) => q.value.cooked ?? q.value.raw).join(' ')
}

const noRawSet = {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow raw SET/RESET and set_config() in SQL (use withTenantTx).' },
    messages: {
      rawSet:
        'Raw SET/RESET and set_config() are not allowed: tenant context is set only by withTenantTx() (packages/db), transaction-locally.',
    },
    schema: [],
  },
  create(context) {
    function check(node, text, first) {
      if (RAW_SET.test(first) || SET_CONFIG.test(text)) {
        context.report({ node, messageId: 'rawSet' })
      }
    }
    return {
      // sql`...`, tx`...`, db.execute(sql`...`): any tagged template is treated as SQL.
      TaggedTemplateExpression(node) {
        const quasis = node.quasi.quasis
        check(node, templateText(node.quasi), quasis[0]?.value.cooked ?? quasis[0]?.value.raw ?? '')
      },
      CallExpression(node) {
        const callee = node.callee
        const name =
          callee.type === 'MemberExpression' && callee.property.type === 'Identifier'
            ? callee.property.name
            : null
        if (!name || !RAW_SQL_CALLEES.has(name)) return
        const arg = node.arguments[0]
        if (arg?.type === 'Literal' && typeof arg.value === 'string') {
          check(node, arg.value, arg.value)
        } else if (arg?.type === 'TemplateLiteral') {
          check(node, templateText(arg), arg.quasis[0]?.value.cooked ?? '')
        }
      },
    }
  },
}

export default {
  meta: { name: 'bizcost' },
  rules: {
    'no-physical-direction-classes': noPhysicalDirectionClasses,
    'no-physical-style-props': noPhysicalStyleProps,
    'no-raw-set': noRawSet,
  },
}
