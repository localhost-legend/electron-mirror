# Electron Scrcpy Mirror (高效能安卓投影鏡像)

這是一個基於 Electron 與 Scrcpy 核心的高效能安卓鏡像與控制應用程式。

## 🌟 核心特色

- **極低延遲影像**：使用 WebCodecs (`VideoDecoder`) 進行硬體加速解碼，延遲低於 100ms。
- **無損音訊傳輸**：即時 48kHz PCM 立體聲，音質清晰無爆音。
- **磁吸式視窗比例**：自動根據手機螢幕比例調整視窗大小，完美貼合不留黑邊。
- **進階輸入 (IME) 支援**：專為中文輸入設計的「可視化輸入列」，支援 Mac 原生注音/拼音選字，採剪貼簿注入技術確保高度穩定性。
- **導航快捷鍵**：側邊欄內建返回、首頁、最近任務按鈕。
- **實體音量模擬**：整合音量增加與減少按鈕。
- **可收合側邊欄**：可隨時隱藏側邊框架，提供沉浸式的遊戲體驗。
- **HiDPI 支援**：針對高解析度螢幕優化 UI 尺寸，支援 1080p+ 影像品質。

## ⚙️ 環境配置 (.env)

本專案支援使用 `.env` 檔案進行環境配置。請在專案根目錄建立 `.env` 檔案並填入以下內容：

```bash
# 指定 Android 設備序號 (必填)
DEVICE_SERIAL=emulator-5556

# 自定義 Scrcpy Server 路徑 (選填，macOS 預設為 Homebrew 路徑)
# SCRCPY_SERVER_PATH=/opt/homebrew/Cellar/scrcpy/3.3.4/share/scrcpy/scrcpy-server

# 自定義 ADB 路徑 (選填)
# ADB_PATH=adb
```

> **注意**：
> 目前以下通訊埠為固定配置 (Hardcoded)：
> - **影像 WebSocket**: `8080`
> - **音訊 WebSocket**: `8081`
> - **ADB 轉發**: `27199`

## 🚀 快速開始

1. 確保您的安卓設備已開啟開發者模式並透過 ADB 連結。
2. 安裝必要的系統組件：
   ```bash
   brew install android-platform-tools
   brew install scrcpy
   ```
3. 安裝專案依賴：
   ```bash
   npm install
   ```
4. 啟動應用程式：
   ```bash
   npm start
   ```

## 🎮 操作說明

- **滑鼠**：標準的點擊、長按與拖曳操作。
- **中文打字**：點擊側邊欄的鍵盤圖示開啟「白色輸入列」，直接在該處打字（支援原生選字窗），按下 Enter 即可送出至手機。
- **側邊欄**：點擊右上角的箭頭可收合；收合後點擊畫面右側懸浮標籤可展開。
- **音量**：位於側邊欄最底部的按鍵。
