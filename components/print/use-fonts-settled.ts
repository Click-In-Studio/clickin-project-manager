"use client";

import { useEffect, useRef, useState } from "react";

type FontsDocument = Document & { fonts?: FontFaceSet };

function fontsOf(): FontFaceSet | undefined {
  return typeof document === "undefined" ? undefined : (document as FontsDocument).fonts;
}

/**
 * 字体是否已就位——分页测量与打印就绪信号的前提（#336 B3）。
 *
 * 为什么不能只等 `document.fonts.ready`：它解析的是「此刻在途的加载」。测量层
 * 挂上去之前它往往已经解析过一次（首屏没几个字），之后测量层渲染出正文才真正
 * 触发字体片下载，而那些加载不会再让 ready 变回 pending。结果就是用回退字体
 * 量完、再等一个早已解析的 promise、然后标 ready——换行点是回退字体算的。
 *
 * 所以改成监听 FontFaceSet 的 loading / loadingdone / loadingerror：每一次字体
 * 到位都调 `onSettled`（调用方拿它重测），「已就位」只在 `fonts.status === "loaded"`
 * 时成立。重测本身可能又引出新的字体片（新的字），于是再来一轮——每片只会加载
 * 一次，总会收敛。
 *
 * 不支持 FontFaceSet 的环境（jsdom）视为恒就位。
 */
export function useFontsSettled(onSettled?: () => void): boolean {
  // SSR 下没有 document：先当就位，挂载后再按真实状态纠正（"use client" 组件仍会
  // 在服务端渲染一次，读 window / document 会 500）。
  const [settled, setSettled] = useState<boolean>(() => {
    const fonts = fontsOf();
    return !fonts || fonts.status === "loaded";
  });
  const onSettledRef = useRef(onSettled);
  onSettledRef.current = onSettled;

  useEffect(() => {
    const fonts = fontsOf();
    if (!fonts) {
      setSettled(true);
      return;
    }
    let cancelled = false;
    const onLoading = () => { if (!cancelled) setSettled(false); };
    const onDone = () => {
      if (cancelled) return;
      setSettled(fonts.status === "loaded");
      onSettledRef.current?.();
    };
    fonts.addEventListener("loading", onLoading);
    fonts.addEventListener("loadingdone", onDone);
    fonts.addEventListener("loadingerror", onDone);
    // 挂载时已有在途加载：ready 解析时补一次（loadingdone 可能在监听前就发过了）
    setSettled(fonts.status === "loaded");
    if (fonts.status !== "loaded") fonts.ready.then(onDone).catch(onDone);
    return () => {
      cancelled = true;
      fonts.removeEventListener("loading", onLoading);
      fonts.removeEventListener("loadingdone", onDone);
      fonts.removeEventListener("loadingerror", onDone);
    };
  }, []);

  return settled;
}
