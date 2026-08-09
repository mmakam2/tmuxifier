// Pure extraction of the Firebase CLIENT config the Android app needs for
// runtime initialization — the values inside an operator's google-services.json
// (project id, sender id, application id, API key). These are public client
// identifiers: every Firebase APK ships them openly. Serving them from the
// operator's own server (GET /api/devices/fcm-config) is what frees the
// published APK from baking in any particular Firebase project — each
// instance's app registers against the project its server declares.
export const APP_PACKAGE = 'com.tmuxifier.console';

export function extractFcmAppConfig(json, packageName = APP_PACKAGE) {
  const projectId = json?.project_info?.project_id;
  const senderId = json?.project_info?.project_number;
  const clients = Array.isArray(json?.client) ? json.client : [];
  const client = clients.find((c) => c?.client_info?.android_client_info?.package_name === packageName);
  const applicationId = client?.client_info?.mobilesdk_app_id;
  const apiKey = Array.isArray(client?.api_key)
    ? client.api_key.find((k) => typeof k?.current_key === 'string' && k.current_key)?.current_key
    : undefined;
  if (!projectId || !senderId || !applicationId || !apiKey) return null;
  return {
    projectId: String(projectId),
    senderId: String(senderId),
    applicationId: String(applicationId),
    apiKey: String(apiKey),
  };
}
