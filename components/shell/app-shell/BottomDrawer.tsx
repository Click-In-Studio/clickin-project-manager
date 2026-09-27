export default function BottomDrawer({
  open,
  onClose,
  children,
}: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  if (!open) return null;
  return (
    <div className="app-shell-bottom-drawer fixed inset-x-0 z-50 lg:hidden flex flex-col justify-end">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="app-shell-bottom-drawer-surface app-mobile-input-surface relative bg-[#e8e8e1] rounded-t-2xl max-h-[75%] overflow-y-auto">
        <div className="flex justify-center pt-3 pb-1">
          <div className="w-8 h-1 bg-[#b0b8b4] rounded-full" />
        </div>
        {children}
      </div>
    </div>
  );
}
