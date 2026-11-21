import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { remarkMentions } from "./remarkMentions";

const components: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow">
      {children}
    </a>
  ),
  img: ({ src, alt }) => (
    // Imagens externas viram link: evita rastreamento e quebra de layout.
    <a href={typeof src === "string" ? src : undefined} target="_blank" rel="noopener noreferrer nofollow">
      {alt || "imagem"}
    </a>
  ),
};

/**
 * Markdown seguro: HTML cru é ignorado (`skipHtml`) e o `urlTransform` padrão do
 * react-markdown remove esquemas perigosos como `javascript:`.
 */
export const Markdown = memo(function Markdown({ text, agentHandles }: { text: string; agentHandles?: Set<string> }) {
  return (
    <div className="tb-md">
      <ReactMarkdown skipHtml remarkPlugins={[remarkGfm, [remarkMentions, { agentHandles }]]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
