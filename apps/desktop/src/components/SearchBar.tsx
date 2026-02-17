import React from "react";
import { useExportBackup } from "../hooks/useData";

interface SearchBarProps {
  value: string;
  onChange: (value: string) => void;
  source: "all" | "chatgpt" | "gemini" | "ai_studio";
  onSourceChange: (source: SearchBarProps["source"]) => void;
}

export function SearchBar({ value, onChange, source, onSourceChange }: SearchBarProps) {
  const exportMutation = useExportBackup();

  return (
    <div className="top-toolbar">
      <input
        className="search-input"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="搜索标题或内容"
      />
      <select value={source} onChange={(event) => onSourceChange(event.target.value as SearchBarProps["source"])}>
        <option value="all">全部来源</option>
        <option value="chatgpt">ChatGPT</option>
        <option value="gemini">Gemini</option>
        <option value="ai_studio">AI Studio</option>
      </select>
      <button
        onClick={() => {
          exportMutation.mutate(undefined, {
            onSuccess: (name) => {
              window.alert(`备份已导出: ${name}`);
            }
          });
        }}
      >
        导出备份
      </button>
    </div>
  );
}
