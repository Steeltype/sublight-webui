// Markdown rendering — marked for parsing, DOMPurify for sanitizing. Every
// markdown-to-DOM path in the UI goes through setMarkdownContent.

marked.setOptions({
  highlight(code, lang) {
    if (lang && hljs.getLanguage(lang)) {
      return hljs.highlight(code, { language: lang }).value;
    }
    return hljs.highlightAuto(code).value;
  },
  breaks: true,
});

export function setMarkdownContent(el, text) {
  const raw = marked.parse(text);
  const fragment = DOMPurify.sanitize(raw, { RETURN_DOM_FRAGMENT: true });
  el.replaceChildren(fragment);
}
