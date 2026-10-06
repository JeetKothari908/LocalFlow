const fs = require('fs'), path = require('path');
const root = path.resolve(__dirname, '../..');
const css = fs.readFileSync(path.join(root, 'packages/ui/src/tokens.scss'), 'utf8');
const parts = css.split('@media');
const read = text => Object.fromEntries([...text.matchAll(/--lf-([\w-]+):\s*(#[a-f\d]{6})/gi)].map(m => [m[1], m[2]]));
const light = read(parts[0]), dark = { ...light, ...read(parts[1]) };
function luminance(hex) {
  const rgb = hex.slice(1).match(/../g).map(v => parseInt(v, 16) / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
}
for (const [name, theme] of Object.entries({ light, dark })) {
  for (const [foreground, background] of [['text', 'background'], ['text', 'surface'], ['muted', 'surface'], ['muted', 'background'], ['danger', 'surface'], ['warning', 'surface'], ['on-accent', 'accent']]) {
    const values = [luminance(theme[foreground]), luminance(theme[background])].sort((a,b) => b-a);
    const ratio = (values[0] + .05) / (values[1] + .05);
    if (ratio < 4.5) throw new Error(`${name} ${foreground}/${background} contrast is ${ratio.toFixed(2)}; requires 4.5`);
  }
}
const swift = fs.readFileSync(path.join(root, 'app/app/LocalFlowTheme.swift'), 'utf8');
for (const key of ['background', 'surface', 'text', 'muted']) {
  const declaration = `static let ${key} = adaptive(light: 0x${light[key].slice(1)}, dark: 0x${dark[key].slice(1)})`;
  if (!swift.includes(declaration)) throw new Error(`Native ${key} differs from the shared palette`);
}
console.log('Light/dark text contrast and native palette mappings verified.');
