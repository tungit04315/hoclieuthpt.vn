'use strict';
// Mỗi export là một Cloud Function (callable) triển khai ở region asia-southeast1.
Object.assign(exports, require('./student'), require('./admin-users'), require('./admin-resources'), require('./admin-catalog'), require('./admin-stats'), require('./admin-content'), require('./requests'));
