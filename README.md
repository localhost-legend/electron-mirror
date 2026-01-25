# Electron Scrcpy Mirror

A high-performance Android mirroring and control application built with Electron and Scrcpy.

## Features

- **Low-Latency Video**: Utilizes WebCodecs (`VideoDecoder`) for ultra-low latency H.264 streaming.
- **High Quality Audio**: Real-time 48kHz PCM stereo audio leveraging protocol-aligned stream parsing.
- **Magnetic Window Snap**: Automatically resizes the window to fit the device's aspect ratio perfectly, including sidebar toggle adjustments.
- **Advanced IME Support**: A dedicated visible input bar for seamless Chinese/English typing using Mac's native IME (via Clipboard Paste injection for maximum stability).
- **Navigation Controls**: On-screen buttons for Back, Home, and Recent apps.
- **Physical Volume Simulation**: Dedicated buttons for Volume Up and Down.
- **Collapsible Sidebar**: Hide the control bar to maximize screen real estate during gaming.
- **HiDPI Ready**: Scaled UI elements and 1080p+ resolution support.

## Prerequisites

- **ADB**: `brew install android-platform-tools`
- **Scrcpy**: `brew install scrcpy` (Server JAR is accessed from the local installation).

## Quick Start

1. Ensure your Android device is connected via ADB.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Start the application:
   ```bash
   npm start
   ```

## Controls

- **Mouse**: Standard touch/click/drag behavior.
- **Keyboard (IME)**: Click the keyboard icon to open the white input bar. Type and press Enter to send (Pastes content + triggers Enter on device).
- **Sidebar**: Toggle with the chevron icon at the top.
- **Volume**: Controls located at the bottom of the sidebar.
