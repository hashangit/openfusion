import { useState } from "react";
import { copyText } from "../api";

/**
 * Render a model's generated text. We preserve whitespace + render common
 * markdown lightly (headings, bold, inline code, code fences, bullet/numbered
 * lists, paragraphs) without pulling in a full markdown dep. Falls back to
 * whitespace-pre-wrap for anything unrecognized.
 */
export function GenerationText({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  if (!text) {
    return <p className="text-sm italic text-white/40">No generation recorded for this sub-call.</p>;
  }
  const copy = async () => {
    if (await copyText(text)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };
  return (
    <div className="relative">
      <button
        className={`btn-icon absolute right-1 top-1 ${copied ? "copied" : ""}`}
        onClick={() => void copy()}
        title="Copy generation"
      >
        {copied ? "✓" : "Copy"}
      </button>
      <div className="generation">{renderMarkdown(text)}</div>
    </div>
  );
}

/** Minimal, safe markdown-ish renderer (no dangerouslySetInnerHTML). */
function renderMarkdown(src: string) {
  const lines = src.split("\n");
  const out: React.ReactNode[] = [];
  let inCode = false;
  let codeBuf: string[] = [];
  let listBuf: React.ReactNode[] = [];
  let para: string[] = [];

  const flushPara = () => {
    if (para.length) {
      out.push(
        <p key={`p-${out.length}`} className="mb-2 leading-relaxed">
          {inline(para.join(" "))}
        </p>,
      );
      para = [];
    }
  };
  const flushList = () => {
    if (listBuf.length) {
      out.push(
        <ul key={`ul-${out.length}`} className="mb-2 ml-5 list-disc space-y-0.5">
          {listBuf}
        </ul>,
      );
      listBuf = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("```")) {
      if (inCode) {
        out.push(
          <pre key={`pre-${out.length}`} className="mb-2 overflow-x-auto rounded bg-black/40 p-2 text-xs">
            <code>{codeBuf.join("\n")}</code>
          </pre>,
        );
        codeBuf = [];
        inCode = false;
      } else {
        flushPara();
        flushList();
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      flushPara();
      flushList();
      const lvl = h[1].length;
      out.push(
        <p key={`h-${out.length}`} className={`mb-1 font-semibold ${lvl <= 2 ? "text-base text-[#4cd0b0]" : "text-sm"}`}>
          {inline(h[2])}
        </p>,
      );
      continue;
    }
    const ul = /^\s*[-*]\s+(.*)$/.exec(line);
    if (ul) {
      flushPara();
      listBuf.push(
        <li key={`li-${out.length}-${i}`} className="text-sm leading-relaxed">
          {inline(ul[1])}
        </li>,
      );
      continue;
    }
    const ol = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (ol) {
      flushPara();
      listBuf.push(
        <li key={`li-${out.length}-${i}`} className="text-sm leading-relaxed">
          {inline(ol[1])}
        </li>,
      );
      continue;
    }
    if (line.trim() === "") {
      flushPara();
      flushList();
      continue;
    }
    listBuf.length && flushList();
    para.push(line);
  }
  if (inCode && codeBuf.length) {
    out.push(
      <pre key={`pre-${out.length}`} className="mb-2 overflow-x-auto rounded bg-black/40 p-2 text-xs">
        <code>{codeBuf.join("\n")}</code>
      </pre>,
    );
  }
  flushList();
  flushPara();
  return out;
}

/** Inline formatting: **bold**, `code`. Returns React nodes. */
function inline(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("**")) {
      nodes.push(<strong key={`b-${k++}`}>{tok.slice(2, -2)}</strong>);
    } else {
      nodes.push(
        <code key={`c-${k++}`} className="rounded bg-black/40 px-1 text-xs text-[#4cd0b0]">
          {tok.slice(1, -1)}
        </code>,
      );
    }
    last = m.index + tok.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}
