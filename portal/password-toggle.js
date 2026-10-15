/*
 * Show/hide button for every password field on the page.
 *
 * Wraps each <input type="password"> in a positioned span and adds an eye
 * button after it. The button only switches the input's type between
 * "password" and "text"; the value never leaves the input. Pages that clear a
 * form (admin.js closing a modal) call PSU_PASSWORD_TOGGLE.reset() so a field
 * reopened later starts hidden again.
 *
 * Built with DOM calls rather than markup strings: the portal's CSP allows no
 * inline script or style, and nothing here needs either.
 */
(() => {
  "use strict";

  const i18n = window.PSU_I18N || {
    t: (key) => key,
    onChange: () => () => {},
  };
  const SVG_NS = "http://www.w3.org/2000/svg";
  const toggles = [];

  function icon(shapes) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    svg.classList.add("password-toggle-icon");
    shapes.forEach(([tag, attributes]) => {
      const shape = document.createElementNS(SVG_NS, tag);
      Object.entries(attributes).forEach(([name, value]) => shape.setAttribute(name, value));
      svg.append(shape);
    });
    return svg;
  }

  const eye = () => icon([
    ["path", { d: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" }],
    ["circle", { cx: "12", cy: "12", r: "3" }],
  ]);
  const eyeOff = () => icon([
    ["path", { d: "M9.88 9.88a3 3 0 1 0 4.24 4.24" }],
    ["path", { d: "M10.73 5.08A10.43 10.43 0 0 1 12 5c6.5 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" }],
    ["path", { d: "M6.61 6.61A13.53 13.53 0 0 0 2 12s3.5 7 10 7a9.74 9.74 0 0 0 5.39-1.61" }],
    ["line", { x1: "2", y1: "2", x2: "22", y2: "22" }],
  ]);

  function render({ input, button }) {
    const shown = input.type === "text";
    button.replaceChildren(shown ? eyeOff() : eye());
    button.setAttribute("aria-pressed", String(shown));
    button.setAttribute("aria-label", i18n.t(shown ? "password.hide" : "password.show"));
    button.title = button.getAttribute("aria-label");
  }

  function attach(input) {
    const wrapper = document.createElement("span");
    wrapper.className = "password-field";
    input.parentNode.insertBefore(wrapper, input);
    wrapper.append(input);

    const button = document.createElement("button");
    button.type = "button";
    button.className = "password-toggle";
    button.setAttribute("aria-controls", input.id);
    wrapper.append(button);

    const toggle = { input, button };
    button.addEventListener("click", () => {
      input.type = input.type === "password" ? "text" : "password";
      render(toggle);
      input.focus();
    });
    // A reset form should not leave a value it is about to refill on show.
    if (input.form) {
      input.form.addEventListener("reset", () => hide(toggle));
    }
    toggles.push(toggle);
    render(toggle);
  }

  function hide(toggle) {
    toggle.input.type = "password";
    render(toggle);
  }

  function init() {
    document.querySelectorAll('input[type="password"]').forEach(attach);
    i18n.onChange(() => toggles.forEach(render));
  }

  window.PSU_PASSWORD_TOGGLE = Object.freeze({
    reset: () => toggles.forEach(hide),
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
