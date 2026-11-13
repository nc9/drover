/**
 * The HTTP status at the head of pi-ai's flattened error text, as a string, or undefined.
 *
 * pi-ai 1.x keeps the status only in the text: `"<status>: <body>"` (the older `"<status> <text>"`
 * also reads), or with a provider label `"<label> (<status>): <body>"`, e.g. `"OpenAI API error
 * (429): ..."`, `"Azure OpenAI API error (503): ..."`, `"Mistral API error (503): ..."`,
 * `"github-copilot API error (413): ..."`. Bounded on purpose: anchored at the start (a status
 * quoted later in a body is never read), a label is one word (a provider id, any case, optionally followed by `API`) or up to three words
 * starting with a capital (`Azure OpenAI API`, `Cloudflare Workers AI`), so a sentence that quotes an
 * error is not read; 4xx and 5xx only.
 */
export function statusOfErrorText(text: string): string | undefined {
  const t = text.trim();
  return (
    /^([45]\d\d)\b/.exec(t)?.[1] ??
    /^(?:[A-Za-z][\w./-]*(?: API)?|[A-Z][\w./-]*(?: [A-Za-z][\w./-]*){1,2}) error \(([45]\d\d)\):/.exec(
      t,
    )?.[1]
  );
}
