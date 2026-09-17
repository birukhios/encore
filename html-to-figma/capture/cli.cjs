const fs = require('node:fs/promises');
const { capture } = require('./browser.cjs');
async function main() {
  const args = process.argv.slice(2), opts = {}; let output = 'capture.figma.json';
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--url') opts.url = args[++i];
    else if (arg === '--html') opts.html = await fs.readFile(args[++i], 'utf8');
    else if (arg === '--base-url') opts.baseUrl = args[++i];
    else if (arg === '--out') output = args[++i];
    else if (arg === '--hover') opts.hover = args[++i];
    else if (arg === '--loop') opts.loop = true;
    else if (arg === '--viewport-only') opts.fullPage = false;
    else if (['--width','--height','--samples','--duration-ms','--wait-ms'].includes(arg)) opts[arg.slice(2).replace(/-([a-z])/g, (_,c) => c.toUpperCase())] = Number(args[++i]);
    else throw new Error(`Unknown option: ${arg}`);
  }
  const result = await capture(opts, text => console.log(text));
  await fs.writeFile(output, JSON.stringify(result));
  console.log(`Saved ${result.screens.length} states to ${output}`);
  result.warnings.forEach(warning => console.warn('• ' + warning));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
