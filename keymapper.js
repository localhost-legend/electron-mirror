const ADBKeyboard = require('adb-keyboard');

function handleKeyboardInput(input) {
  if (input.type === 'password') {
    // Use ADBKeyboard for password fields
    ADBKeyboard.type(input.value);
  } else {
    // Use existing keyboard injection for other fields
    injectKeyboardInput(input.value);
  }
}

function injectKeyboardInput(input) {
  // Existing keyboard injection implementation
}
