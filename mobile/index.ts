// Loaded before anything else so the shared sync engine can rely on them.
import './src/lib/polyfills';

import { registerRootComponent } from 'expo';

// Defines the background sync task at module scope, which a headless wake-up
// needs (see the file), then makes sure Android has it scheduled.
import { registerBackgroundSync } from './src/background/backgroundSync';
void registerBackgroundSync();

import App from './App';

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
