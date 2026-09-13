import Link from "next/link";

export default function MobileTab({
  label,
  symbol,
  active,
  href,
  onClick,
}: {
  label: string;
  symbol: React.ReactNode;
  active: boolean;
  href?: string;
  onClick?: () => void;
}) {
  const cls = `flex-1 flex flex-col items-center gap-1 py-3 text-[10px] font-medium transition-colors ${
    active ? "text-[#182a2a]" : "text-[#667676]"
  }`;
  const inner = (
    <>
      <span className="h-[18px] flex items-center justify-center leading-none text-base">
        {symbol}
      </span>
      {label}
    </>
  );
  if (href) return <Link href={href} className={cls}>{inner}</Link>;
  return <button onClick={onClick} className={cls}>{inner}</button>;
}
