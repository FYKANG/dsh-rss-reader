/**
 * A minimal React-compatible renderer for the client bundle test.
 *
 * The DSH web boot provides React as a platform seed module, but React is not
 * published as an installable package in this environment (it ships bundled
 * inside the harness frontend). This shim implements the subset the RSS panel
 * uses — `createElement`, `useState`, `useEffect`, `useMemo`, `useCallback`,
 * `useRef`, `Fragment` — plus a render loop, so the component's real render
 * path can be exercised rather than mocked away.
 *
 * It is deliberately small and only supports what the panel needs: function
 * components, host elements, string children, arrays, and falsy children.
 * Anything else throws loudly, so an unsupported feature surfaces as a test
 * failure instead of a silently wrong tree.
 */

/** Whether a value is a React element node produced by createElement. */
function isElement(value) {
  return value !== null && typeof value === "object" && value.__element === true;
}

/** Normalize children into a flat array, dropping null/undefined/booleans. */
function normalizeChildren(children) {
  const out = [];
  const walk = (value) => {
    if (value === null || value === undefined || typeof value === "boolean") return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    out.push(value);
  };
  for (const child of children) walk(child);
  return out;
}

/**
 * Create the shim's React object plus a renderer.
 * @returns {{react: object, render: Function, textContent: Function, find: Function}}
 */
export function createReactShim() {
  /** Per-component-instance hook storage, keyed by tree position. */
  const instances = new Map();
  /** Effects scheduled during the current pass. */
  let pendingEffects = [];
  /** Set when a state setter ran, so the caller knows to re-render. */
  let dirty = false;
  /** Current component instance while its body executes. */
  let current = null;

  /**
   * The path segment identifying one child among its siblings.
   *
   * A keyed child keeps its identity where an unkeyed one is identified by
   * position. This mirrors React: an element's state survives a re-render when
   * the element is matched by key, and is thrown away when the matching is only
   * positional — so a harness that always used the index would report a remount
   * React never performs, and miss one it does.
   *
   * @param {unknown} child - the child node.
   * @param {number} index - its position among the rendered children.
   * @returns {string | number} the segment.
   */
  function childPathKey(child, index) {
    return child !== null && typeof child === "object" && child.key !== undefined ? child.key : index;
  }

  /** Slot storage for the component instance at `key`. */
  function instanceAt(key) {
    let inst = instances.get(key);
    if (inst === undefined) {
      inst = { slots: [], cursor: 0 };
      instances.set(key, inst);
    }
    return inst;
  }

  /** Read or create the hook slot at the current cursor. */
  function slot(create) {
    if (current === null) throw new Error("hooks may only be called while rendering a component");
    if (current.cursor >= current.slots.length) current.slots.push(create());
    return current.slots[current.cursor++];
  }

  /** Re-render is scheduled by flagging the pass dirty. */
  function scheduleUpdate() {
    dirty = true;
  }

  const react = {
    Fragment: Symbol.for("react.fragment"),

    createElement(type, props, ...children) {
      const key = props?.key === undefined ? undefined : String(props.key);
      const { key: _key, ...rest } = props ?? {};
      return {
        __element: true,
        type,
        props: { ...rest, children: normalizeChildren(children) },
        key
      };
    },

    useState(initial) {
      // Capture the owning instance now: a setter is commonly called from an
      // async handler, long after this render finished, so it must not read the
      // module-level "current instance" at call time.
      const inst = current;
      if (inst === null) throw new Error("useState called outside a render");
      const slotIndex = inst.cursor;
      const value = slot(() => (typeof initial === "function" ? initial() : initial));
      // The setter is stable across renders, matching React's contract.
      const setter = (next) => {
        const previous = inst.slots[slotIndex];
        inst.slots[slotIndex] = typeof next === "function" ? next(previous) : next;
        scheduleUpdate();
      };
      return [value, setter];
    },

    useRef(initial) {
      return slot(() => ({ current: initial }));
    },

    useCallback(fn, deps) {
      // Dependencies must be honoured. Returning the first `fn` forever would
      // give every callback a permanently stale closure — the exact bug class
      // these tests exist to catch, and one that would make the suite lie.
      if (current === null) throw new Error("useCallback called outside a render");
      const index = current.cursor;
      if (index >= current.slots.length) {
        current.slots.push({ fn, deps });
        current.cursor += 1;
        return current.slots[index].fn;
      }
      const record = current.slots[current.cursor++];
      const changed = deps === undefined
        || record.deps === undefined
        || deps.length !== record.deps.length
        || deps.some((dep, i) => !Object.is(dep, record.deps[i]));
      if (changed) {
        record.fn = fn;
        record.deps = deps;
      }
      return record.fn;
    },

    useEffect(effect, deps) {
      const index = current === null ? -1 : current.cursor;
      const record = slot(() => ({ deps, cleanup: undefined, ran: false }));
      const changed = !record.ran
        || deps === undefined
        || record.deps === undefined
        || deps.length !== record.deps.length
        || deps.some((dep, i) => !Object.is(dep, record.deps[i]));
      if (changed) {
        record.deps = deps;
        record.ran = true;
        pendingEffects.push({ record, effect });
      }
    }
  };

  // useMemo must return the cached value, which the slot helper cannot express
  // directly (it returns the slot). Wrap it to unwrap.
  react.useMemo = (factory, deps) => {
    if (current === null) throw new Error("useMemo called outside a render");
    const index = current.cursor;
    if (index >= current.slots.length) {
      current.slots.push({ value: factory(), deps });
      current.cursor += 1;
      return current.slots[index].value;
    }
    const record = current.slots[current.cursor++];
    const changed = deps === undefined
      || record.deps === undefined
      || deps.length !== record.deps.length
      || deps.some((dep, i) => !Object.is(dep, record.deps[i]));
    if (changed) {
      record.value = factory();
      record.deps = deps;
    }
    return record.value;
  };

  /**
   * Render one element tree to a plain node tree.
   * @param {object} element - root element.
   * @param {string} [path] - tree position, used to key component instances.
   * @returns {object} `{type, props, children, text}` node.
   */
  function renderNode(element, path) {
    if (typeof element === "string" || typeof element === "number") {
      return { type: "#text", text: String(element), children: [] };
    }
    if (Array.isArray(element)) {
      return { type: "#array", children: element.map((child, i) => renderNode(child, `${path}.${i}`)) };
    }
    if (!isElement(element)) throw new Error(`unsupported child: ${String(element)}`);

    const { type, props, key } = element;
    if (type === react.Fragment) {
      return {
        type: "#fragment",
        props,
        children: props.children.map((child, i) => renderNode(child, `${path}.${key ?? i}`))
      };
    }
    if (typeof type === "function") {
      const instanceKey = `${type.name || "anon"}@${path}${key === undefined ? "" : `#${key}`}`;
      const inst = instanceAt(instanceKey);
      const previous = current;
      current = inst;
      inst.cursor = 0;
      let output;
      try {
        output = type(props);
      } finally {
        current = previous;
      }
      return renderNode(output, `${instanceKey}/out`);
    }
    if (typeof type === "string") {
      return {
        type,
        props,
        children: props.children.map((child, i) => renderNode(child, `${path}.${childPathKey(child, i)}`))
      };
    }
    throw new Error(`unsupported element type: ${String(type)}`);
  }

  /**
   * Render an element, running effects and re-rendering until the tree settles.
   *
   * @param {object} element - root element.
   * @param {{maxPasses?: number}} [options] - pass cap.
   * @returns {Promise<object>} the final node tree.
   */
  async function render(element, options = {}) {
    const maxPasses = options.maxPasses ?? 25;
    let tree;
    for (let pass = 0; pass < maxPasses; pass += 1) {
      dirty = false;
      pendingEffects = [];
      tree = renderNode(element, "root");
      const effects = pendingEffects;
      pendingEffects = [];
      // Run effects, then let any promise they started settle so a follow-up
      // state update can schedule another pass.
      for (const { record, effect } of effects) {
        const cleanup = effect();
        if (typeof cleanup === "function") record.cleanup = cleanup;
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (!dirty) return tree;
    }
    throw new Error(`render did not settle within ${maxPasses} passes`);
  }

  /** Concatenated text of a rendered tree. */
  function textContent(node) {
    if (node === undefined) return "";
    if (node.type === "#text") return node.text;
    return (node.children ?? []).map(textContent).join(" ").replace(/\s+/g, " ").trim();
  }

  /** All nodes matching a predicate, depth-first. */
  function collect(node, predicate, out = []) {
    if (predicate(node)) out.push(node);
    for (const child of node.children ?? []) collect(child, predicate, out);
    return out;
  }

  /** Every node whose type is the given tag. */
  function findAll(node, tag) {
    return collect(node, (candidate) => candidate.type === tag);
  }

  /**
   * The first node whose text contains `needle`.
   * @returns {object | undefined} the node.
   */
  function findByText(node, needle) {
    return collect(node, (candidate) => typeof candidate.text === "string" && candidate.text.includes(needle))[0];
  }

  return { react, render, textContent, findAll, findByText };
}
