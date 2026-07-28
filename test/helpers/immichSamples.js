// Response shapes captured from a live Immich v3.0.3 server, with every real
// host name, user name and count replaced. The field names are the contract —
// Immich moved these endpoints from /api/server-info/* to /api/server/* around
// v1.118, so a rename here is exactly the regression these fixtures catch.

export const ABOUT = {
  version: 'v3.0.3',
  versionUrl: 'https://github.com/immich-app/immich/releases/tag/v3.0.3',
  licensed: false,
  nodejs: 'v24.14.1',
  exiftool: '13.59',
  ffmpeg: '7.1.4-3',
};

export const STORAGE = {
  diskAvailable: '624.0 GiB',
  diskSize: '1.0 TiB',
  diskUse: '400.0 GiB',
  diskAvailableRaw: 670014898176,
  diskSizeRaw: 1099511627776,
  diskUseRaw: 429496729600,
  diskUsagePercentage: 39.06,
};

export const STATISTICS = {
  photos: 48300,
  videos: 1200,
  usage: 322122547200,
  usagePhotos: 107374182400,
  usageVideos: 214748364800,
  usageByUser: [
    { userId: 'u-1', userName: 'Example User', photos: 48000, videos: 1150, usage: 311385128960, quotaSizeInBytes: null },
    { userId: 'u-2', userName: 'Second User', photos: 300, videos: 50, usage: 10737418240, quotaSizeInBytes: null },
    { userId: 'u-3', userName: 'Third User', photos: 0, videos: 0, usage: 0, quotaSizeInBytes: null },
  ],
};

const idleQueue = () => ({
  queueStatus: { isPaused: false, isActive: false },
  jobCounts: { active: 0, completed: 0, failed: 0, delayed: 0, waiting: 0, paused: 0 },
});

// The live server reports fifteen queues; the rollup must sum across all of
// them rather than reading a hand-picked few.
export const JOB_NAMES = [
  'thumbnailGeneration', 'metadataExtraction', 'videoConversion', 'faceDetection',
  'facialRecognition', 'smartSearch', 'duplicateDetection', 'backgroundTask',
  'storageTemplateMigration', 'migration', 'search', 'sidecar', 'library',
  'notifications', 'backupDatabase',
];

export const JOBS_IDLE = Object.fromEntries(JOB_NAMES.map((n) => [n, idleQueue()]));

export const JOBS_BUSY = {
  ...JOBS_IDLE,
  thumbnailGeneration: {
    queueStatus: { isPaused: false, isActive: true },
    jobCounts: { active: 2, completed: 900, failed: 1, delayed: 5, waiting: 100, paused: 0 },
  },
  metadataExtraction: {
    queueStatus: { isPaused: true, isActive: false },
    jobCounts: { active: 1, completed: 40, failed: 2, delayed: 0, waiting: 20, paused: 7 },
  },
};

export const VERSION_CHECK = { checkedAt: '2026-07-28T23:06:00.095Z', releaseVersion: 'v3.0.3' };
export const VERSION_CHECK_NEWER = { checkedAt: '2026-07-28T23:06:00.095Z', releaseVersion: 'v3.1.0' };
export const CONFIG = { trashDays: 30, isInitialized: true, isOnboarded: true, maintenanceMode: false };
export const CONFIG_MAINTENANCE = { ...CONFIG, maintenanceMode: true };
