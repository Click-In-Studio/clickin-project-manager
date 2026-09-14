export default function NavGroup({ label, color, folded, first }: { label: string; color: "overview" | "script" | "stage"; folded?: boolean; first?: boolean }) {
  // v3：分组标题为深色填充条（原型 navGroupTitle）——总览 #526461、创作侧 ink、制作侧深棕
  return (
    <div
      className={`${first ? "mt-0" : "mt-[15px]"} mb-1 flex items-center gap-2 rounded-[8px] text-white ${
        folded ? "min-h-[28px] justify-center px-0" : "min-h-[32px] px-[11px]"
      } ${color === "script" ? "bg-[#182a2a]" : color === "overview" ? "bg-[#526461]" : "bg-[#4d3328]"}`}
      title={folded ? label : undefined}
    >
      <span
        className={`w-[7px] h-[7px] rounded-full shrink-0 ${
          color === "script" ? "bg-[#7fc0c7]" : color === "overview" ? "bg-[#d8e3df]" : "bg-[#e9a578]"
        }`}
      />
      {!folded && (
        <span className="whitespace-nowrap text-[10px] font-bold tracking-[0.12em] uppercase text-[#f4f7f5]">
          {label}
        </span>
      )}
    </div>
  );
}
