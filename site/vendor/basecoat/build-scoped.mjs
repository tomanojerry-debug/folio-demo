// Reproducible extraction from the official basecoat-css@1.1.0 CDN stylesheet.
// No component declarations are redesigned here: retain selected upstream rules,
// namespace their variables, and put only their required defaults on components.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const [sourcePath, toolingDirectory] = process.argv.slice(2);
if (!sourcePath || !toolingDirectory) {
  throw new Error('Usage: node build-scoped.mjs OFFICIAL_CDN_CSS TOOLING_DIRECTORY');
}
const require = createRequire(path.resolve(toolingDirectory, 'package.json'));
const postcss = require('postcss');
const selectorParser = require('postcss-selector-parser');
const source = await readFile(sourcePath, 'utf8');
if (!source.startsWith('/*! tailwindcss v4.3.1')) throw new Error('Unexpected upstream CSS build.');
const ast = postcss.parse(source);
const classes = new Set(['btn', 'input', 'textarea', 'dropdown-menu']);
const attributes = new Set(['data-popover', 'data-tooltip']);
const selected = [];

for (const layer of ast.nodes) {
  if (layer.type !== 'atrule' || layer.name !== 'layer' || layer.params !== 'components') continue;
  for (const node of layer.nodes || []) {
    if (node.type !== 'rule') continue;
    const selectors = selectorParser().astSync(node.selector).nodes.filter(selector => {
      const first = selector.nodes.find(part => part.type !== 'comment');
      return first && ((first.type === 'class' && classes.has(first.value)) ||
        (first.type === 'attribute' && attributes.has(first.attribute)));
    });
    if (!selectors.length) continue;
    const copy = node.clone();
    copy.selector = selectors.map(selector => selector.toString().trim()).join(', ');
    selected.push(copy);
  }
}
if (selected.length < 30) throw new Error('Upstream selectors changed; inspect before updating.');

const defaults = new Map();
ast.walkRules(rule => {
  if (![':root, :host', ':root'].includes(rule.selector)) return;
  rule.nodes?.filter(node => node.type === 'decl' && node.prop.startsWith('--'))
    .forEach(node => defaults.set(node.prop, node.value));
});
const properties = new Map();
ast.walkAtRules('property', rule => properties.set(rule.params, rule));
const variableNames = value => [...value.matchAll(/var\(\s*(--[\w-]+)/g)].map(match => match[1]);
const required = new Set();
for (const rule of selected) rule.walkDecls(decl => variableNames(decl.value).forEach(name => required.add(name)));
const queue = [...required];
for (let index = 0; index < queue.length; index++) {
  const value = defaults.get(queue[index]);
  if (!value) continue;
  for (const dependency of variableNames(value)) {
    if (!required.has(dependency)) { required.add(dependency); queue.push(dependency); }
  }
}
const scope = ':where(.btn, .input, .textarea, .dropdown-menu, [data-tooltip])';
const result = postcss.root();
result.append(postcss.comment({ text: '! Basecoat 1.1.0 / MIT — scoped component subset for FORME.\n * Derived mechanically by build-scoped.mjs from dist/basecoat.cdn.css.\n * Upstream: https://basecoatui.com/ — see LICENSE.md and LICENSE.tailwindcss.\n * No global reset, document styles, external fonts, or unprefixed tokens. ' }));
result.append(postcss.atRule({ name: 'layer', params: 'basecoat-defaults, basecoat-components' }));
const theme = postcss.rule({ selector: scope });
for (const [name, value] of defaults) {
  if (required.has(name)) theme.append(postcss.decl({ prop: name, value }));
}
const initialValues = postcss.rule({ selector: `${scope}, ${scope} *, ${scope}::before, ${scope}::after, ${scope} *::before, ${scope} *::after` });
for (const name of required) {
  const property = properties.get(name);
  const initial = property?.nodes.find(node => node.type === 'decl' && node.prop === 'initial-value');
  if (initial) initialValues.append(postcss.decl({ prop: name, value: initial.value }));
}
const defaultLayer = postcss.atRule({ name: 'layer', params: 'basecoat-defaults' });
defaultLayer.append(theme);
if (initialValues.nodes.length) defaultLayer.append(initialValues);
result.append(defaultLayer);
const componentLayer = postcss.atRule({ name: 'layer', params: 'basecoat-components' });
componentLayer.append(selected);
result.append(componentLayer);
for (const name of required) if (properties.has(name)) result.append(properties.get(name).clone());
// Namespacing includes both public tokens and Tailwind's internal @property names.
const output = result.toString().replace(/--([a-zA-Z_][\w-]*)/g, '--bc-$1') + '\n';
if (/(?:^|\n)\s*(?::root|html|body|\*)\s*[{,]/.test(output)) throw new Error('Unexpected global selector.');
if (/@(?:import|font-face|keyframes)\b/.test(output)) throw new Error('Unexpected global dependency.');
await writeFile(path.join(path.dirname(fileURLToPath(import.meta.url)), 'basecoat-scoped.css'), output);
console.log(`Extracted ${selected.length} official rules and ${theme.nodes.length} component-scoped defaults.`);
