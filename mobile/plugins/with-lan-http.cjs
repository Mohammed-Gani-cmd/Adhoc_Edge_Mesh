// The coordinator uses HTTP on a trusted LAN. Set the native manifest explicitly;
// android.usesCleartextTraffic is not an Expo app-config property.
const { AndroidConfig, withAndroidManifest } = require('expo/config-plugins');

module.exports = function withLanHttp(config) {
  return withAndroidManifest(config, result => {
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(result.modResults);
    application.$['android:usesCleartextTraffic'] = 'true';
    return result;
  });
};
