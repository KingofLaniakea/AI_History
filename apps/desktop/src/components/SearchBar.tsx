import React from "react";
import { useExportBackup } from "../hooks/useData";

interface SearchBarProps {
  value: string;
  onChange: (value: string) => void;
  source: "all" | "chatgpt" | "gemini" | "ai_studio" | "claude";
  onSourceChange: (source: SearchBarProps["source"]) => void;
}

export function SearchBar({ value, onChange, source, onSourceChange }: SearchBarProps) {
  return (
    <div className="top-toolbar">
      <div className="search-input-wrap">
        <svg className="search-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="8" />
          <path d="M21 21l-4.35-4.35" />
        </svg>
        <input
          className="search-input"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="搜索标题或内容"
        />
        {value && (
          <button className="search-clear" onClick={() => onChange("")} title="清除搜索">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>
      <select value={source} onChange={(event) => onSourceChange(event.target.value as SearchBarProps["source"])}>
        <option value="all">全部来源</option>
        <option value="chatgpt">ChatGPT</option>
        <option value="gemini">Gemini</option>
        <option value="ai_studio">AI Studio</option>
        <option value="claude">Claude</option>
      </select>
    </div>
  );
}
