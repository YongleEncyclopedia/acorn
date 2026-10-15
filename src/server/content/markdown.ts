import TurndownService from "turndown";

let service: TurndownService | null = null;

export function toMarkdown(html: string): string {
  if (!service) {
    service = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-", emDelimiter: "*" });
    service.keep(["table", "iframe", "video", "audio", "sub", "sup"]);
    service.addRule("figcaption", {
      filter: "figcaption",
      replacement: (content) => (content.trim() ? `\n*${content.trim()}*\n` : ""),
    });
  }
  return service.turndown(html || "").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}
