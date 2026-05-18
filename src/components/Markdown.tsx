import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export default function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div
      className={`prose prose-invert prose-sm max-w-none prose-headings:text-gold-300 prose-strong:text-neutral-100 prose-code:text-amber-200 prose-li:my-0.5 prose-a:text-sky-300 hover:prose-a:underline ${className ?? ""}`}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}
