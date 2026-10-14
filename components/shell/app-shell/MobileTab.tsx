import Link from "next/link";

export default function MobileTab({
  label,
  symbol,
  active,
  expanded,
  href,
  onClick,
}: {
  label: string;
  symbol: React.ReactNode;
  active: boolean;
  expanded?: boolean;
  href?: string;
  onClick?: () => void;
}) {
  const cls = `min-w-0 flex-1 flex flex-col items-center justify-center gap-1 px-1 py-3 text-[10px] font-medium transition-colors ${
    active ? "bg-[#182a2a] text-white" : "text-[#667676]"
  }`;
  const inner = (
    <>
      <span className="h-[18px] flex items-center justify-center leading-none text-base">
        {symbol}
      </span>
      <span className="max-w-full whitespace-nowrap leading-tight">{label}</span>
    </>
  );
  if (href) return <Link href={href} onClick={onClick} aria-current={active ? "page" : undefined} className={cls}>{inner}</Link>;
  return <button type="button" onClick={onClick} aria-current={active ? "page" : undefined} aria-expanded={expanded} className={cls}>{inner}</button>;
}
