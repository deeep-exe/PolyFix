import { useMemo, type ReactNode } from "react";
import type { ExtensionDocs, ParameterValue } from "../api/client";

type Props = {
  docs: ExtensionDocs | null;
  loading: boolean;
  error: string;
  onLoadRecommended: (params: Record<string, ParameterValue>) => void;
};

function renderInline(text: string): ReactNode[] {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  return parts.map((part, index) => {
    if (part.startsWith("`") && part.endsWith("`")) {
      return <code key={index}>{part.slice(1, -1)}</code>;
    }
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    }
    return part;
  });
}

export default function ExtensionDocPanel({ docs, loading, error, onLoadRecommended }: Props) {
  const rendered = useMemo(() => {
    if (!docs?.raw_markdown) return [];
    const blocks: ReactNode[] = [];
    const lines = docs.raw_markdown.split("\n");
    let paragraph: string[] = [];
    let codeLines: string[] = [];
    let inCode = false;

    const flushParagraph = () => {
      if (!paragraph.length) return;
      const text = paragraph.join(" ").trim();
      if (text) blocks.push(<p key={`p-${blocks.length}`}>{renderInline(text)}</p>);
      paragraph = [];
    };

    lines.forEach((line) => {
      if (line.startsWith("```")) {
        if (inCode) {
          blocks.push(<pre key={`code-${blocks.length}`}><code>{codeLines.join("\n")}</code></pre>);
          codeLines = [];
          inCode = false;
        } else {
          flushParagraph();
          codeLines = [];
          inCode = true;
        }
        return;
      }
      if (inCode) {
        codeLines.push(line);
        return;
      }
      if (!line.trim() || line.trim().startsWith("---")) {
        flushParagraph();
        return;
      }
      const heading = line.match(/^(#{1,3})\s+(.+)$/);
      if (heading) {
        flushParagraph();
        const text = heading[2];
        blocks.push(heading[1].length === 1
          ? <h3 key={`h-${blocks.length}`}>{renderInline(text)}</h3>
          : <h4 key={`h-${blocks.length}`}>{renderInline(text)}</h4>);
        return;
      }
      if (/^[-*]\s+/.test(line)) {
        flushParagraph();
        blocks.push(<li key={`li-${blocks.length}`}>{renderInline(line.replace(/^[-*]\s+/, ""))}</li>);
        return;
      }
      paragraph.push(line.trim());
    });
    flushParagraph();
    if (inCode) blocks.push(<pre key={`code-${blocks.length}`}><code>{codeLines.join("\n")}</code></pre>);
    return blocks;
  }, [docs]);

  return (
    <details className="extension-doc-panel">
      <summary>Model Docs &amp; Requirements</summary>
      <div className="extension-doc-content">
        {loading && <p className="extension-doc-status">Loading documentation…</p>}
        {error && <p className="extension-doc-status error">{error}</p>}
        {docs && (
          <>
            {docs.vram_requirement && (
              <div className="extension-doc-hardware">
                <strong>Hardware</strong>
                <span>{docs.vram_requirement}</span>
              </div>
            )}
            <p className="extension-doc-summary">{docs.summary}</p>
            {Object.keys(docs.recommended_params).length > 0 && (
              <button
                type="button"
                className="extension-doc-load"
                onClick={() => onLoadRecommended(docs.recommended_params)}
              >
                Load Recommended Settings from Docs
              </button>
            )}
            <div className="extension-doc-markdown">{rendered}</div>
            {docs.source_url && (
              <a href={docs.source_url} target="_blank" rel="noreferrer">Official source</a>
            )}
          </>
        )}
      </div>
    </details>
  );
}
