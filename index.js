module.exports = {
  StorageFactory: require('./lib/StorageFactory'),
  EnvironmentDetector: require('./lib/EnvironmentDetector'),
  WinstonLogger: require('./lib/WinstonLogger'),
  DateTimeUtils: require('./lib/DateTimeUtils'),
  FilesystemStorage: require('./lib/FilesystemStorage'),
  S3Storage: require('./lib/S3Storage'),
  S3expressStorage: require('./lib/S3expressStorage')
};
