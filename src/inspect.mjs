/* global window, document, getComputedStyle */

// Serialized into the Playwright CLI session with toString(). Keep every function self-contained.
export async function observe(page, target, options = {}) {
  const { limit = 5, textLimit = 300, css = [], attributes = [] } = options;
  if (!Number.isInteger(limit) || limit < 1 || limit > 20)
    throw new Error("observe limit must be between 1 and 20.");
  if (!Number.isInteger(textLimit) || textLimit < 0 || textLimit > 2000)
    throw new Error("observe textLimit must be between 0 and 2000.");
  for (const fields of [css, attributes])
    if (
      !Array.isArray(fields) ||
      fields.length > 20 ||
      fields.some((field) => typeof field !== "string")
    )
      throw new Error("observe accepts at most 20 CSS properties and 20 attributes.");
  const locator = typeof target === "string" ? page.locator(target) : target;
  return locator.evaluateAll(
    (elements, { limit, textLimit, css, attributes }) => {
      const viewport = {
        width: window.innerWidth,
        height: window.innerHeight,
        dpr: window.devicePixelRatio,
      };
      return {
        viewport,
        count: elements.length,
        truncated: elements.length > limit,
        elements: elements.slice(0, limit).map((element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          const visible =
            rect.width > 0 &&
            rect.height > 0 &&
            !["hidden", "collapse"].includes(style.visibility) &&
            style.display !== "none";
          const text = visible ? (element.innerText ?? element.textContent ?? "") : "";
          const clippedBy = [];
          for (let parent = element.parentElement; parent; parent = parent.parentElement) {
            const parentStyle = getComputedStyle(parent);
            const box = parent.getBoundingClientRect();
            const x =
              /^(auto|scroll|hidden|clip|overlay)$/.test(parentStyle.overflowX) &&
              (rect.left < box.left || rect.right > box.right);
            const y =
              /^(auto|scroll|hidden|clip|overlay)$/.test(parentStyle.overflowY) &&
              (rect.top < box.top || rect.bottom > box.bottom);
            if ((x || y) && clippedBy.length < 5)
              clippedBy.push({ tag: parent.tagName.toLowerCase(), id: parent.id || null, x, y });
          }
          return {
            tag: element.tagName.toLowerCase(),
            text: text.slice(0, textLimit),
            textTruncated: text.length > textLimit,
            visible,
            inViewport:
              visible &&
              rect.right > 0 &&
              rect.bottom > 0 &&
              rect.left < viewport.width &&
              rect.top < viewport.height,
            outsideViewport: {
              left: rect.left < 0,
              top: rect.top < 0,
              right: rect.right > viewport.width,
              bottom: rect.bottom > viewport.height,
            },
            box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            focused: element === document.activeElement,
            scroll: {
              left: element.scrollLeft,
              top: element.scrollTop,
              width: element.scrollWidth,
              height: element.scrollHeight,
              clientWidth: element.clientWidth,
              clientHeight: element.clientHeight,
            },
            clippedBy,
            attributes: Object.fromEntries(
              attributes.map((name) => [name, element.getAttribute(name)]),
            ),
            css: Object.fromEntries(css.map((name) => [name, style.getPropertyValue(name)])),
          };
        }),
      };
    },
    { limit, textLimit, css, attributes },
  );
}

// The adapter's read-only accessor runs in the page; this wrapper bounds what may be asked for.
// `spec` is { sections, defaults, read (page-side function), target }. A production target has no
// development accessors: it reports unsupported rather than inventing internal state.
export async function readState(page, requested, spec) {
  const sections = requested ?? spec.defaults;
  if (!Array.isArray(sections) || sections.some((section) => !spec.sections.includes(section)))
    throw new Error(`state sections: ${spec.sections.join(", ") || "(none registered)"}.`);
  if (spec.target === "production" || !spec.read)
    return {
      url: page.url(),
      unsupported:
        spec.target === "production"
          ? "Production builds carry no development accessors; assert visible UI or durable storage instead."
          : "This project registers no state accessor.",
    };
  return page.evaluate(spec.read, sections);
}
