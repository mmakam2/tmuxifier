import { test, expect } from 'vitest';
import { extractFcmAppConfig } from '../src/server/fcmAppConfig.js';

const FIXTURE = {
  project_info: { project_number: '123456789012', project_id: 'their-project', storage_bucket: 'x' },
  client: [
    {
      client_info: { mobilesdk_app_id: '1:123456789012:android:other', android_client_info: { package_name: 'com.other.app' } },
      api_key: [{ current_key: 'AIzaOther' }],
    },
    {
      client_info: { mobilesdk_app_id: '1:123456789012:android:deadbeef', android_client_info: { package_name: 'com.tmuxifier.console' } },
      api_key: [{ current_key: 'AIzaRight' }],
    },
  ],
};

test('extracts the client entry matching the app package', () => {
  expect(extractFcmAppConfig(FIXTURE, 'com.tmuxifier.console')).toEqual({
    projectId: 'their-project',
    senderId: '123456789012',
    applicationId: '1:123456789012:android:deadbeef',
    apiKey: 'AIzaRight',
  });
});

test('defaults to the app package', () => {
  expect(extractFcmAppConfig(FIXTURE).apiKey).toBe('AIzaRight');
});

test('missing package or malformed input reads as null, never a throw', () => {
  expect(extractFcmAppConfig(FIXTURE, 'com.absent')).toBe(null);
  expect(extractFcmAppConfig({}, 'com.tmuxifier.console')).toBe(null);
  expect(extractFcmAppConfig(null, 'com.tmuxifier.console')).toBe(null);
  expect(extractFcmAppConfig({ project_info: { project_id: 'p' }, client: 'nope' })).toBe(null);
});
