// Single source of truth for the inline logo. Points at the same /logo.png
// that the browser tab uses (see index.html), so the favicon and the in-app
// logo stay byte-identical.

export default function ButterflyIcon({ className }: { className?: string }) {
  return (
    <img
      src="/logo.png"
      alt="Gold Butterfly"
      className={className}
      draggable={false}
    />
  );
}
