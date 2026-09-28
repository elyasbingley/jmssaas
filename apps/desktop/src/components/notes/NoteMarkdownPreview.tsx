import { useMemo } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { preprocessNoteMarkdown } from "./noteMarkdownTransform";
import { resolveTitle, type TitleLookupEntry } from "./notesData";

// Live markdown preview for the note editor - [[wikilinks]] and #tags are
// rewritten to clickable custom-scheme links by preprocessNoteMarkdown,
// then intercepted here in the `a` component. An unresolved wikilink (no
// matching note title) renders red/dashed per the spec and, on click,
// creates that note and navigates to it.

const WIKILINK_SCHEME = "wikilink://";
const TAGFILTER_SCHEME = "tagfilter://";

function noteUrlTransform(value: string): string {
  if (value.startsWith(WIKILINK_SCHEME) || value.startsWith(TAGFILTER_SCHEME)) return value;
  return defaultUrlTransform(value);
}

export interface NoteMarkdownPreviewProps {
  body: string;
  titleIndex: Map<string, TitleLookupEntry>;
  onNavigateToNote: (noteId: string) => void;
  onCreateAndNavigate: (title: string) => void;
  onFilterByTag: (tag: string) => void;
}

export function NoteMarkdownPreview({ body, titleIndex, onNavigateToNote, onCreateAndNavigate, onFilterByTag }: NoteMarkdownPreviewProps) {
  const processed = useMemo(() => preprocessNoteMarkdown(body), [body]);

  const components = useMemo<Components>(
    () => ({
      a: ({ href, children, ...rest }) => {
        if (href?.startsWith(WIKILINK_SCHEME)) {
          const target = decodeURIComponent(href.slice(WIKILINK_SCHEME.length));
          const resolved = resolveTitle(titleIndex, target);
          return (
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                if (resolved) onNavigateToNote(resolved.id);
                else onCreateAndNavigate(target);
              }}
              title={resolved ? target : `"${target}" doesn't exist yet - click to create it`}
              style={
                resolved
                  ? { color: "var(--jms-accent)", textDecoration: "none", borderBottom: "1px solid var(--jms-accent)" }
                  : { color: "var(--jms-danger)", textDecoration: "none", borderBottom: "1px dashed var(--jms-danger)" }
              }
            >
              {children}
            </a>
          );
        }
        if (href?.startsWith(TAGFILTER_SCHEME)) {
          const tag = decodeURIComponent(href.slice(TAGFILTER_SCHEME.length));
          return (
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                onFilterByTag(tag);
              }}
              style={{ color: "var(--jms-accent)", textDecoration: "none" }}
            >
              {children}
            </a>
          );
        }
        return (
          <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: "var(--jms-accent)" }} {...rest}>
            {children}
          </a>
        );
      },
      blockquote: ({ children, ...rest }) => (
        <blockquote
          style={{
            borderLeft: "3px solid var(--jms-border)",
            paddingLeft: 12,
            marginLeft: 0,
            marginBlock: 8,
            color: "var(--jms-text-muted)",
          }}
          {...rest}
        >
          {children}
        </blockquote>
      ),
      code: ({ className, children, ...rest }) => {
        const isBlock = /language-/.test(className ?? "");
        return (
          <code
            className={className}
            style={
              isBlock
                ? { display: "block", overflowX: "auto", padding: 12, backgroundColor: "var(--jms-bg)", border: "1px solid var(--jms-border)", borderRadius: 4 }
                : { backgroundColor: "var(--jms-bg)", padding: "1px 4px", borderRadius: 3 }
            }
            {...rest}
          >
            {children}
          </code>
        );
      },
      table: ({ children, ...rest }) => (
        <table style={{ borderCollapse: "collapse", width: "100%" }} {...rest}>
          {children}
        </table>
      ),
      th: ({ children, ...rest }) => (
        <th style={{ border: "1px solid var(--jms-border)", padding: "4px 8px", textAlign: "left", color: "var(--jms-text)" }} {...rest}>
          {children}
        </th>
      ),
      td: ({ children, ...rest }) => (
        <td style={{ border: "1px solid var(--jms-border)", padding: "4px 8px" }} {...rest}>
          {children}
        </td>
      ),
    }),
    [titleIndex, onNavigateToNote, onCreateAndNavigate, onFilterByTag]
  );

  return (
    <div className="note-markdown-preview" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)", lineHeight: 1.6 }}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={noteUrlTransform} components={components}>
        {processed || "*Nothing to preview yet.*"}
      </ReactMarkdown>
    </div>
  );
}
