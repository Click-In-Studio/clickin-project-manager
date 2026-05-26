"use client";

import { useState, useEffect, useRef } from "react";
import {
  parseDuration,
  formatDuration,
} from "@/lib/duration";

type Props = {
  /** 持续时间，单位秒 */
  value: number | null | undefined;
  /** 是否可编辑 */
  canEdit: boolean;
  /** 保存回调，参数为秒数 */
  onSave: (seconds: number | null) => Promise<void>;
  /** 占位符 */
  placeholder?: string;
  /** 额外的 CSS 类名 */
  className?: string;
};

export default function DurationInput({
  value,
  canEdit,
  onSave,
  placeholder = "—",
  className = "",
}: Props) {
  const [isEditing, setIsEditing] = useState(false);
  const [textInput, setTextInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // 格式化为 MM:SS
  const formatAsMMSS = (seconds: number | null | undefined): string => {
    if (seconds == null || isNaN(seconds) || seconds < 0) return "";
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  };

  // 解析 MM:SS 格式（分:秒）
  const parseMMSS = (str: string): number | null => {
    const match = str.match(/^(\d+):(\d+)$/);
    if (match) {
      const m = parseInt(match[1], 10);
      const s = parseInt(match[2], 10);
      return m * 60 + Math.min(59, s);
    }
    return null;
  };

  // 当外部 value 变化时，更新内部状态
  useEffect(() => {
    setTextInput(formatAsMMSS(value) || "");
  }, [value]);

  // 点击外部关闭编辑模式
  useEffect(() => {
    if (!isEditing) return;
    
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        commit();
      }
    };
    
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isEditing, textInput]);

  // 开始编辑
  const startEditing = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!canEdit || saving) return;
    setIsEditing(true);
    setParseError(null);
    setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
  };

  // 提交保存
  const commit = async () => {
    if (!isEditing) return;

    const trimmed = textInput.trim();
    let finalValue: number | null = null;
    
    if (trimmed !== "") {
      // 优先尝试解析 MM:SS 格式
      let parsed = parseMMSS(trimmed);
      if (parsed == null) {
        parsed = parseDuration(trimmed);
      }
      if (parsed == null) {
        setParseError("无法识别的时间格式，请重新输入");
        return;
      }
      finalValue = parsed;
    }

    // 如果值没有变化，直接退出编辑模式
    if (finalValue === value) {
      setIsEditing(false);
      return;
    }

    setSaving(true);
    setParseError(null);
    try {
      await onSave(finalValue);
      setIsEditing(false);
    } catch (err) {
      console.error("保存时长失败:", err);
    } finally {
      setSaving(false);
    }
  };

  // 取消编辑
  const cancel = (e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setTextInput(formatAsMMSS(value) || "");
    setIsEditing(false);
    setParseError(null);
  };

  // 按键处理
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      cancel();
    }
  };

  // 非编辑模式下的显示
  if (!canEdit || !isEditing) {
    const displayText = value != null && value > 0 ? formatDuration(value) : placeholder;
    return (
      <div
        ref={containerRef}
        className={`text-xs py-1 px-2 rounded border border-transparent hover:border-zinc-200 cursor-pointer transition-colors min-h-[1.25rem] ${
          canEdit ? "hover:bg-zinc-50" : ""
        } ${className}`}
        onClick={startEditing}
      >
        {displayText === placeholder ? (
          <span className="text-zinc-300 italic">{placeholder}</span>
        ) : (
          <span className="text-zinc-600">{displayText}</span>
        )}
      </div>
    );
  }

  return (
    <div ref={containerRef} className={`space-y-2 ${className}`}>
      {/* 输入区域 */}
      <div className="flex items-center gap-2">
        <input
          ref={inputRef}
          type="text"
          value={textInput}
          onChange={(e) => {
            e.stopPropagation();
            setTextInput(e.target.value);
            setParseError(null);
          }}
          onKeyDown={handleKeyDown}
          disabled={saving}
          className="flex-1 rounded border border-zinc-200 px-2 py-1.5 text-sm outline-none focus:border-zinc-400 disabled:opacity-50"
          placeholder="如：1:30、1分30秒、90秒"
        />
        {/* 实时预览 */}
        {textInput.trim() && (
          <div className="text-xs text-zinc-500 whitespace-nowrap">
            {(() => {
              let parsed = parseMMSS(textInput);
              if (parsed == null) {
                parsed = parseDuration(textInput);
              }
              if (parsed == null) {
                return <span className="text-amber-600">格式错误</span>;
              }
              return (
                <span>
                  <span className="text-zinc-700">{formatDuration(parsed)}</span>
                </span>
              );
            })()}
          </div>
        )}
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); commit(); }}
          disabled={saving}
          className="rounded bg-zinc-800 px-3 py-1.5 text-xs text-white hover:bg-zinc-700 disabled:opacity-50 whitespace-nowrap transition-colors"
        >
          保存
        </button>
        <button
          type="button"
          onClick={cancel}
          disabled={saving}
          className="text-xs text-zinc-400 hover:text-zinc-600 disabled:opacity-50 whitespace-nowrap transition-colors"
        >
          取消
        </button>
      </div>
      {/* 错误提示 */}
      {parseError && (
        <div className="text-xs text-red-500">{parseError}</div>
      )}
    </div>
  );
}
