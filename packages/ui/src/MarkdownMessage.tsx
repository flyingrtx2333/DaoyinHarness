import { memo } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

// Model output is untrusted. Render syntax as React elements, never raw HTML,
// and keep remote images from making requests merely by opening a transcript.
export const MarkdownMessage = memo(function MarkdownMessage({ text }: { text: string }): React.JSX.Element {
  return <Markdown
    remarkPlugins={[remarkGfm]}
    skipHtml
    urlTransform={(url) => /^(https?:\/\/|mailto:|#)/i.test(url) ? url : ""}
    components={{
      a: ({ href, children }) => href
        ? <a href={href} target={href.startsWith("#") ? undefined : "_blank"} rel="noopener noreferrer">{children}</a>
        : <span>{children}</span>,
      img: ({ alt }) => <span className="image-description">{alt ? `[图片：${alt}]` : "[图片]"}</span>,
      table: ({ children }) => <div className="markdown-table" role="region" aria-label="回答中的表格" tabIndex={0}><table>{children}</table></div>,
    }}
  >{text}</Markdown>;
});
