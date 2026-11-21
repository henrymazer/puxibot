import { memo, useMemo } from "react";
import { Link } from "react-router-dom";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { WikiPageDTO } from "@puxibot/shared";
import { normalizeTitle, remarkWikiLinks, titleIndex } from "../../lib/wikiLinks";
import { paths } from "../../lib/paths";
import { cn } from "../../lib/cn";
import { useWorkspace } from "../../store/workspace";
import { remarkMentions } from "../chat/remarkMentions";

/** Endereço para criar a página que um [[link]] cita e ainda não existe. */
export const newPageHref = (ws: string, title: string) => `${paths.wiki(ws)}?nova=${encodeURIComponent(title)}`;

/**
 * Markdown da wiki: mesmo pipeline seguro do chat (HTML cru ignorado) mais [[links]] entre páginas,
 * que navegam dentro do app. Link para página inexistente leva à criação dela.
 */
export const WikiMarkdown = memo(function WikiMarkdown({
  text,
  pages,
  ws,
  className,
}: {
  text: string;
  pages: WikiPageDTO[];
  ws: string;
  className?: string;
}) {
  const agents = useWorkspace((s) => s.agents);
  const agentHandles = useMemo(() => new Set(Object.values(agents).map((a) => a.handle)), [agents]);
  const index = useMemo(() => titleIndex(pages), [pages]);
  const wikiOpts = useMemo(
    () => ({
      resolve: (t: string) => {
        const id = index.get(normalizeTitle(t));
        return id ? paths.wiki(ws, id) : null;
      },
      createHref: (t: string) => newPageHref(ws, t),
    }),
    [index, ws],
  );
  const components = useMemo<Components>(
    () => ({
      a: ({ href, children, className: cls, title }) => {
        if (href && href.startsWith("/") && !href.startsWith("//")) {
          const missing = typeof cls === "string" && cls.includes("tb-wikilink-missing");
          return (
            <Link to={href} className={cls} title={missing ? "Esta página ainda não existe. Clique para criar." : title}>
              {children}
            </Link>
          );
        }
        return (
          <a href={href} target="_blank" rel="noopener noreferrer nofollow">
            {children}
          </a>
        );
      },
      img: ({ src, alt }) => (
        <a href={typeof src === "string" ? src : undefined} target="_blank" rel="noopener noreferrer nofollow">
          {alt || "imagem"}
        </a>
      ),
    }),
    [],
  );
  return (
    <div className={cn("tb-md tb-wiki-doc", className)}>
      <ReactMarkdown skipHtml remarkPlugins={[remarkGfm, [remarkMentions, { agentHandles }], [remarkWikiLinks, wikiOpts]]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
