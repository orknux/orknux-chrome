// A page as a model reads it: its controls and text, in document order, from
// the accessibility tree Chrome already computes. Each control carries a ref -
// "e" and its backend DOM node id - which stays valid while the page lives, so
// a click can name it without the extension keeping a table.

const CONTROLS = new Set([
  'button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch',
  'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'option', 'slider',
  'spinbutton', 'treeitem', 'listbox',
]);

const SHOWN_STATES = ['checked', 'selected', 'expanded', 'disabled', 'required', 'focused'];

const LONGEST_TEXT = 300;

function flat(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function quoted(text) {
  const cut = text.length > LONGEST_TEXT ? text.slice(0, LONGEST_TEXT) + '…' : text;
  return '"' + cut.replace(/"/g, '\\"') + '"';
}

function stateOf(node) {
  const said = [];
  for (const property of node.properties ?? []) {
    if (!SHOWN_STATES.includes(property.name)) continue;
    const value = property.value?.value;
    if (value === false || value === 'false' || value === undefined) continue;
    said.push(value === true || value === 'true' ? property.name : `${property.name}=${value}`);
  }
  return said;
}

/** The lines of a page, from the nodes `Accessibility.getFullAXTree` answers. */
export function linesOf(nodes, { interactiveOnly = false } = {}) {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const root = nodes.find((node) => !node.parentId) ?? nodes[0];
  const lines = [];
  const visit = (id, quiet) => {
    const node = byId.get(id);
    if (!node) return;
    let hush = quiet;
    if (!node.ignored) {
      const role = node.role?.value ?? '';
      const name = flat(node.name?.value);
      if (CONTROLS.has(role) && node.backendDOMNodeId) {
        let line = `[e${node.backendDOMNodeId}] ${role}`;
        if (name) line += ' ' + quoted(name);
        const value = flat(node.value?.value);
        if (value && value !== name) line += ' value=' + quoted(value);
        const states = stateOf(node);
        if (states.length) line += ' (' + states.join(', ') + ')';
        lines.push(line);
        // Its text is its name already.
        hush = true;
      } else if (role === 'heading' && name && !interactiveOnly) {
        const level = (node.properties ?? []).find((p) => p.name === 'level')?.value?.value;
        lines.push(`heading${level ? ' ' + level : ''} ${quoted(name)}`);
        hush = true;
      } else if (role === 'image' && name && !interactiveOnly && !quiet) {
        lines.push(`image ${quoted(name)}`);
      } else if (role === 'StaticText' && name && !interactiveOnly && !quiet) {
        lines.push(quoted(name).slice(1, -1));
      }
    }
    for (const child of node.childIds ?? []) visit(child, hush);
  };
  if (root) visit(root.nodeId, false);
  return lines;
}

/**
 * The answer to browser_snapshot: a heading naming the page, then its lines,
 * narrowed by `find` and cut at `maxCharacters` on a line's end.
 */
export function render({ title, url, tab, lines, find, maxCharacters }) {
  let shown = lines;
  if (find) {
    const wanted = String(find).toLowerCase();
    shown = lines.filter((line) => line.toLowerCase().includes(wanted));
  }
  const head = `Page: ${title || '(untitled)'} - ${url}\nTab: ${tab}\n`;
  let text = head;
  let kept = 0;
  for (const line of shown) {
    if (text.length + line.length + 1 > maxCharacters) break;
    text += line + '\n';
    kept++;
  }
  const result = { tab, title, url, text };
  if (kept < shown.length) {
    result.cut = `${shown.length - kept} more lines were cut. Ask for a part with find, take interactiveOnly, or scroll.`;
  }
  if (find && shown.length === 0) result.note = `Nothing on the page contains "${find}".`;
  return result;
}
