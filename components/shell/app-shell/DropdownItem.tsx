import Link from "next/link";

export default function DropdownItem({ href, onClick, children }: { href: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      onClick={onClick}
      className="flex items-center gap-2 px-2.5 py-2 rounded-[7px] text-[11px] text-[#182a2a] hover:bg-[var(--paper)] transition-colors"
    >
      {children}
    </Link>
  );
}
