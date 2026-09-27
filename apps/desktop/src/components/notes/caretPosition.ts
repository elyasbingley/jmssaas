// Pixel coordinates of the caret inside a <textarea>, for positioning the
// wikilink-autocomplete dropdown near where the user is actually typing.
// Classic "mirror div" technique: clone the textarea's text-affecting CSS
// onto an off-screen div containing the text up to the caret plus a marker
// span, then read the marker's offsetTop/offsetLeft.

const MIRRORED_PROPERTIES: (keyof CSSStyleDeclaration)[] = [
  "boxSizing",
  "width",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "letterSpacing",
  "lineHeight",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "whiteSpace",
  "wordWrap",
];

export interface CaretCoordinates {
  top: number;
  left: number;
  height: number;
}

export function getCaretCoordinates(textarea: HTMLTextAreaElement, caretIndex: number): CaretCoordinates {
  const div = document.createElement("div");
  const style = window.getComputedStyle(textarea);
  for (const prop of MIRRORED_PROPERTIES) {
    const value = style[prop];
    if (typeof value === "string") div.style.setProperty(String(prop).replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`), value);
  }
  div.style.position = "absolute";
  div.style.visibility = "hidden";
  div.style.whiteSpace = "pre-wrap";
  div.style.wordWrap = "break-word";
  div.style.top = "0";
  div.style.left = "-9999px";

  const textBefore = textarea.value.substring(0, caretIndex);
  const textAfter = textarea.value.substring(caretIndex) || ".";
  div.textContent = textBefore;
  const marker = document.createElement("span");
  marker.textContent = textAfter[0] ?? ".";
  div.appendChild(marker);
  div.append(document.createTextNode(textAfter.substring(1)));

  document.body.appendChild(div);
  const coords: CaretCoordinates = {
    top: marker.offsetTop + parseInt(style.borderTopWidth || "0", 10),
    left: marker.offsetLeft + parseInt(style.borderLeftWidth || "0", 10),
    height: marker.offsetHeight,
  };
  document.body.removeChild(div);
  return coords;
}
