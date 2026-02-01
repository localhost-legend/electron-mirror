export default {
  packagerConfig: {
    asar: {
      unpack: '**/scrcpy-win64-v*/**'
    },
  },
  makers: [
    {
      name: '@electron-forge/maker-zip',
      platforms: ['win32']
    }
  ]
};
