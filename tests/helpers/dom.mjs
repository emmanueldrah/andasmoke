/**
 * A minimal DOM, just enough to test the scanner's field-exemption rule.
 *
 * The app must install and run with no internet, so a full DOM library is not
 * something to add a dependency for. The rule under test only inspects an
 * element's tag, attributes, `closest()` and a couple of properties, so this
 * provides exactly that and nothing more.
 */

class FakeElement {
  constructor(tagName, attributes = {}) {
    this.tagName = String(tagName).toUpperCase();
    this.attributes = { ...attributes };
    this.children = [];
    this.parentNode = null;
    // nodeType 1 is ELEMENT_NODE; the rule checks it before touching anything else.
    this.nodeType = 1;
    // Derived the way a real element is, so the rule can read `.type` directly.
    this.id = attributes.id || '';
    this.name = attributes.name || '';
  }

  getAttribute(name) {
    const value = this.attributes[name];
    return value === undefined ? null : String(value);
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === 'id') this.id = String(value);
    if (name === 'name') this.name = String(value);
  }

  get type() {
    return this.getAttribute('type') || 'text';
  }

  get value() {
    return this.attributes.value ?? '';
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  /** Walks up the tree looking for an ancestor (or self) with the attribute. */
  closest(selector) {
    const match = /^\[([a-zA-Z-]+)\]$/.exec(selector);
    if (!match) return null;
    const attribute = match[1];
    let node = this;
    while (node) {
      if (node.getAttribute(attribute) !== null) return node;
      node = node.parentNode;
    }
    return null;
  }
}

class FakeDocument {
  constructor() {
    this.body = new FakeElement('body');
  }

  createElement(tagName) {
    return new FakeElement(tagName);
  }

  /** Builds a detached input with the given attributes, attached to the body. */
  input(attributes = {}) {
    const element = new FakeElement('input', attributes);
    this.body.appendChild(element);
    return element;
  }
}

export class JSDOM {
  constructor() {
    this.window = { document: new FakeDocument() };
  }

  get document() {
    return this.window.document;
  }

  /**
   * Compiles a function out of TypeScript-ish source and returns it.
   *
   * The annotations are stripped first, so the shipped component source can be
   * compiled directly. That way the test cannot drift from what the app runs.
   */
  loadFunctionFromSource(source) {
    const body = stripTypes(source);
    return new Function(`return (${body});`)();
  }
}

/**
 * Removes TypeScript and ESM syntax from a single function declaration.
 *
 * Comments are blanked first, because several of the patterns below would
 * otherwise chew through the prose in a doc comment and corrupt the code after it.
 * String literals are deliberately *not* touched: the rule under test compares
 * against `[data-barcode-input]` at runtime, so blanking it would change what is
 * actually being tested.
 */
function stripTypes(source) {
  const masked = blankComments(source);

  return masked
    // Exported from the component; drop the ESM keyword so the result evaluates
    // as a bare expression.
    .replace(/^\s*export\s+/, '')
    // A parameter list with types. Stops at the closing paren, so a union type
    // such as `EventTarget | HTMLElement | null` is removed whole.
    .replace(/\((\w+)\s*:\s*[^)\n]*\)/g, '($1)')
    // A return type between the parameter list and the body.
    .replace(/\)\s*:\s*[A-Za-z_$][\w$<>\[\]|,\s]*\{/g, ') {')
    // `as Type` and `as const` casts, including unions and null.
    .replace(/\s+as\s+(?:const|[A-Za-z_$][\w$]*(?:<[^<>]*>)?(?:\[\])?)(?:\s*\|\s*[A-Za-z_$][\w$]*(?:\[\])?)*(?:\s*\|\s*null)?/g, '')
    // Non-null assertions before a property access.
    .replace(/!\./g, '.');
}

/** Replaces comment bodies with spaces, preserving every offset. */
function blankComments(source) {
  let out = '';
  let index = 0;
  while (index < source.length) {
    const two = source.slice(index, index + 2);
    if (two === '//') {
      const end = source.indexOf('\n', index);
      const stop = end === -1 ? source.length : end;
      out += spaces(source.slice(index, stop));
      index = stop;
    } else if (two === '/*') {
      const end = source.indexOf('*/', index + 2);
      const stop = end === -1 ? source.length : end + 2;
      out += spaces(source.slice(index, stop));
      index = stop;
    } else if (source[index] === '"' || source[index] === "'" || source[index] === '`') {
      // Copy the literal through untouched, so string contents survive.
      const quote = source[index];
      let cursor = index + 1;
      while (cursor < source.length && source[cursor] !== quote) {
        if (source[cursor] === '\\') cursor++;
        cursor++;
      }
      const stop = Math.min(cursor + 1, source.length);
      out += source.slice(index, stop);
      index = stop;
    } else {
      out += source[index];
      index++;
    }
  }
  return out;
}

const spaces = (text) => ' '.repeat(text.length);