# Electron Mirror (v1.0)

這是一個基於 **Electron**、**WebCodecs** 與 **ADBKit** 構建的高效能 Android 投屏客戶端。
專為零延遲、高畫質鏡像而設計，摒棄臃腫的第三方框架，還原最純粹的原生體驗。

## 功能特色
- **純原生核心 (Pure Native Core)**：完全手寫實現 Scrcpy 協議 (TCP/Sockets)，無外部依賴。
- **硬體解碼 (Hardware Decoding)**：直接調用瀏覽器原生的 `WebCodecs` API 進行 H.264 解碼，效能極佳。
- **智能視窗貼齊 (Smart Snap)**：視窗會自動偵測視訊比例並完美貼齊，消除黑邊。
- **側邊欄整合 (Sidebar)**：內建導航、按鍵映射與視窗管理功能。
- **多視窗支援 (Multi-Window)**：支援同時開啟鏡像視窗與裝置總覽面板。

## 技術堆疊
- **執行環境**: Electron
- **後端**: ADBKit & Node.js net/dgram
- **前端**: Vanilla JS + Web Codecs API
- **通訊協議**: Scrcpy Protocol (相容 v1.22 ~ v2.0)

## 安裝與執行
1. `npm install`
2. `npm start`
