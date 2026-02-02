# Electron Scrcpy Mirror

這是一個以 Electron + scrcpy server 為核心的 Android 螢幕鏡像與控制工具，使用 WebCodecs 解碼與 WebSocket 傳輸。

## ✨ 主要功能

- **低延遲影像**：WebCodecs (`VideoDecoder`) 解碼 H.264 串流。
- **即時音訊**：48kHz PCM 立體聲播放。
- **裝置 Launcher**：自動掃描 ADB 裝置，點選即可連線。
- **總覽面板 (Overview)**：裝置資訊、檔案管理、App 管理、通知清單。
- **鏡像控制側邊欄**：返回/首頁/最近任務、音量、全螢幕、可釘選或自動隱藏。
- **中文輸入列 (IME)**：側邊欄開啟白色輸入列，剪貼簿注入送字。
- **鍵位映射**：WASD 搖桿 + 點擊映射，支援 Profile 與裝置別名。
- **自動下載 scrcpy (Windows)**：首次啟動自動下載並使用內建 ADB。

## 🖥️ 平台支援

- **Windows 10/11 (x64)**：正式支援，啟動時自動下載 scrcpy。
- **macOS**：目前僅為實驗狀態，路徑與下載流程尚未完整支援。

## 🚀 開發啟動

1. 確認 Android 裝置已開啟「開發者選項」與「USB 偵錯」，並完成授權。
2. 安裝依賴：
   ```bash
   npm install
   ```
3. 啟動：
   ```bash
   npm start
   ```

首次啟動若未偵測到 scrcpy，會自動下載對應版本。

## 🎮 使用方式

- **Launcher**：選擇裝置後自動連線並開啟鏡像。
- **Overview**：查看裝置資訊、檔案管理（上傳/下載/刪除）、App 管理（啟動/安裝/移除/導出 APK）、通知列表。
- **鏡像視窗**：滑鼠點擊/拖曳操作，側邊欄可切換鍵位映射與輸入列。

## 📁 專案結構

- main/：主程序與 IPC、scrcpy/ADB 控制
- UI/：Launcher / Overview / Screen Mirror UI
- keymaps/：鍵位映射設定檔（JSON）
