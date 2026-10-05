const axios = require('axios');
const express = require('express');
const { sql, getPool } = require('../../../config/db');
const { requireAuth } = require('../../middlewares/auth');
const { getConnectedPages } = require('../../utils/FacebookPageConnections');
const { getFacebookPageAccessToken } = require('../../utils/FacebookPageAccessToken');

const router = express.Router();
const graphVersion = process.env.FB_GRAPH_VERSION || 'v19.0';
let inboxSchema;

async function ensureInboxSchema() {
  if (!inboxSchema) {
    inboxSchema = getPool().then((pool) => pool.request().query(`
      IF OBJECT_ID(N'dbo.FacebookInboxComments', N'U') IS NULL
      BEGIN
        CREATE TABLE dbo.FacebookInboxComments (
          page_id varchar(64) NOT NULL,
          comment_id varchar(64) NOT NULL,
          post_id varchar(128) NOT NULL,
          page_name nvarchar(200) NOT NULL,
          post_message nvarchar(max) NULL,
          comment_message nvarchar(max) NOT NULL,
          commenter_id varchar(64) NULL,
          commenter_name nvarchar(200) NOT NULL,
          comment_created_at datetime2 NOT NULL,
          reply_count int NOT NULL CONSTRAINT DF_FacebookInboxComments_reply_count DEFAULT 0,
          permalink_url nvarchar(1000) NULL,
          status varchar(20) NOT NULL CONSTRAINT DF_FacebookInboxComments_status DEFAULT 'open',
          assigned_to_user_id varchar(64) NULL,
          first_reply_at datetime2 NULL,
          last_synced_at datetime2 NOT NULL CONSTRAINT DF_FacebookInboxComments_synced_at DEFAULT SYSUTCDATETIME(),
          CONSTRAINT PK_FacebookInboxComments PRIMARY KEY (page_id, comment_id)
        );
      END;
      IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name=N'IX_FacebookInboxComments_page_status_created' AND object_id=OBJECT_ID(N'dbo.FacebookInboxComments'))
        CREATE INDEX IX_FacebookInboxComments_page_status_created ON dbo.FacebookInboxComments(page_id, status, comment_created_at DESC);
      IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name=N'IX_FacebookInboxComments_assigned' AND object_id=OBJECT_ID(N'dbo.FacebookInboxComments'))
        CREATE INDEX IX_FacebookInboxComments_assigned ON dbo.FacebookInboxComments(assigned_to_user_id, status);
    `)).catch((error) => {
      inboxSchema = null;
      throw error;
    });
  }
  await inboxSchema;
}

function isValidPageId(pageId) {
  return typeof pageId === 'string' && /^\d{1,64}$/.test(pageId);
}

async function getUserPages(userId) {
  return getConnectedPages(userId);
}

function addPageFilters(request, pages) {
  const parameters = pages.map((page, index) => {
    const name = `page${index}`;
    request.input(name, sql.VarChar(64), String(page.id));
    return `@${name}`;
  });
  return `page_id IN (${parameters.join(', ')})`;
}

async function syncPageComments(page, accessToken, pool) {
  const postsResponse = await axios.get(`https://graph.facebook.com/${graphVersion}/${encodeURIComponent(page.id)}/published_posts`, {
    params: { fields: 'id,message,created_time,permalink_url', limit: 12, access_token: accessToken },
    timeout: 20000
  });
  const posts = postsResponse.data.data || [];
  let synced = 0;

  for (let start = 0; start < posts.length; start += 4) {
    const batch = posts.slice(start, start + 4);
    const commentsByPost = await Promise.all(batch.map(async (post) => {
      const response = await axios.get(`https://graph.facebook.com/${graphVersion}/${encodeURIComponent(post.id)}/comments`, {
        params: {
          fields: 'id,message,from,created_time,comment_count,permalink_url',
          limit: 50,
          order: 'reverse_chronological',
          access_token: accessToken
        },
        timeout: 20000
      });
      return { post, comments: response.data.data || [] };
    }));

    for (const { post, comments } of commentsByPost) {
      for (const comment of comments) {
        if (!comment.id) continue;
        if (String(comment.from?.id || '') === String(page.id)) continue;
        const createdAt = new Date(comment.created_time);
        if (Number.isNaN(createdAt.getTime())) continue;
        const replyCount = Math.max(0, Number.parseInt(comment.comment_count, 10) || 0);
        await pool.request()
          .input('pageId', sql.VarChar(64), String(page.id))
          .input('commentId', sql.VarChar(64), String(comment.id).slice(0, 64))
          .input('postId', sql.VarChar(128), String(post.id).slice(0, 128))
          .input('pageName', sql.NVarChar(200), String(page.name || 'Facebook Page').slice(0, 200))
          .input('postMessage', sql.NVarChar(sql.MAX), typeof post.message === 'string' ? post.message : null)
          .input('commentMessage', sql.NVarChar(sql.MAX), String(comment.message || 'Bình luận không có nội dung văn bản.').slice(0, 10000))
          .input('commenterId', sql.VarChar(64), comment.from?.id ? String(comment.from.id).slice(0, 64) : null)
          .input('commenterName', sql.NVarChar(200), String(comment.from?.name || 'Người dùng Facebook').slice(0, 200))
          .input('createdAt', sql.DateTime2, createdAt)
          .input('replyCount', sql.Int, replyCount)
          .input('permalink', sql.NVarChar(1000), String(comment.permalink_url || post.permalink_url || '').slice(0, 1000) || null)
          .query(`
            UPDATE dbo.FacebookInboxComments
            SET page_name=@pageName, post_message=@postMessage, comment_message=@commentMessage,
              commenter_id=@commenterId, commenter_name=@commenterName, comment_created_at=@createdAt,
              reply_count=@replyCount, permalink_url=@permalink, last_synced_at=SYSUTCDATETIME(),
              status=CASE WHEN @replyCount > 0 AND status='open' THEN 'resolved' ELSE status END
            WHERE page_id=@pageId AND comment_id=@commentId;
            IF @@ROWCOUNT=0
              INSERT INTO dbo.FacebookInboxComments (
                page_id, comment_id, post_id, page_name, post_message, comment_message,
                commenter_id, commenter_name, comment_created_at, reply_count, permalink_url, status
              ) VALUES (
                @pageId, @commentId, @postId, @pageName, @postMessage, @commentMessage,
                @commenterId, @commenterName, @createdAt, @replyCount, @permalink,
                CASE WHEN @replyCount > 0 THEN 'resolved' ELSE 'open' END
              );
          `);
        synced += 1;
      }
    }
  }
  return synced;
}

async function findAccessibleComment(userId, commentId) {
  const pages = await getUserPages(userId);
  if (!pages.length) return { pages, comment: null };
  const pool = await getPool();
  const request = pool.request().input('commentId', sql.VarChar(64), commentId);
  const pageFilter = addPageFilters(request, pages);
  const result = await request.query(`SELECT TOP (1) page_id, comment_id, status FROM dbo.FacebookInboxComments WHERE comment_id=@commentId AND ${pageFilter}`);
  return { pages, comment: result.recordset[0] || null };
}

router.use(requireAuth);

router.get('/comments', async (req, res) => {
  try {
    const pages = await getUserPages(req.user.sub);
    if (!pages.length) return res.json({ success: true, comments: [], stats: emptyStats(), pages: [] });
    await ensureInboxSchema();
    const pageId = typeof req.query.pageId === 'string' ? req.query.pageId : '';
    const accessiblePages = pageId ? pages.filter((page) => String(page.id) === pageId) : pages;
    if (pageId && !accessiblePages.length) return res.status(403).json({ success: false, message: 'Bạn không có quyền truy cập Fanpage này.' });

    const request = (await getPool()).request();
    const pageFilter = addPageFilters(request, accessiblePages);
    const filter = String(req.query.filter || 'all');
    const filters = [pageFilter];
    if (filter === 'unanswered') filters.push("reply_count=0 AND status<>'resolved'");
    else if (filter === 'attention') filters.push("reply_count=0 AND status<>'resolved' AND comment_created_at<=DATEADD(hour,-24,SYSUTCDATETIME())");
    else if (['open', 'in_progress', 'resolved'].includes(filter)) filters.push('status=@status');
    else if (filter !== 'all') return res.status(400).json({ success: false, message: 'Bộ lọc không hợp lệ.' });
    if (['open', 'in_progress', 'resolved'].includes(filter)) request.input('status', sql.VarChar(20), filter);

    const pool = await getPool();
    const commentsResult = await request.query(`
      SELECT TOP (300) c.comment_id AS commentId, c.page_id AS pageId, c.page_name AS pageName,
        c.post_id AS postId, c.post_message AS postMessage, c.comment_message AS commentText,
        c.commenter_id AS commenterId, c.commenter_name AS commenterName,
        c.comment_created_at AS createdAt, c.reply_count AS replyCount, c.permalink_url AS permalinkUrl,
        c.status, c.assigned_to_user_id AS assigneeUserId, u.display_name AS assigneeName,
        c.first_reply_at AS firstReplyAt
      FROM dbo.FacebookInboxComments c
      LEFT JOIN dbo.FacebookUsers u ON u.facebook_user_id=c.assigned_to_user_id
      WHERE ${filters.join(' AND ')}
      ORDER BY CASE WHEN c.reply_count=0 AND c.status<>'resolved' AND c.comment_created_at<=DATEADD(hour,-24,SYSUTCDATETIME()) THEN 0 ELSE 1 END,
        c.comment_created_at DESC;
    `);
    const statsRequest = pool.request();
    const statsPageFilter = addPageFilters(statsRequest, accessiblePages);
    const statsResult = await statsRequest.query(`
      SELECT COUNT(*) AS total,
        SUM(CASE WHEN reply_count=0 AND status<>'resolved' THEN 1 ELSE 0 END) AS unanswered,
        SUM(CASE WHEN reply_count=0 AND status<>'resolved' AND comment_created_at<=DATEADD(hour,-24,SYSUTCDATETIME()) THEN 1 ELSE 0 END) AS attention,
        SUM(CASE WHEN status='in_progress' THEN 1 ELSE 0 END) AS inProgress,
        SUM(CASE WHEN status='resolved' OR reply_count>0 THEN 1 ELSE 0 END) AS resolved,
        AVG(CAST(DATEDIFF(MINUTE, comment_created_at, first_reply_at) AS float)) AS averageResponseMinutes
      FROM dbo.FacebookInboxComments WHERE ${statsPageFilter};
    `);
    const stats = statsResult.recordset[0] || {};
    return res.json({
      success: true,
      comments: commentsResult.recordset,
      pages,
      stats: {
        total: Number(stats.total || 0),
        unanswered: Number(stats.unanswered || 0),
        attention: Number(stats.attention || 0),
        inProgress: Number(stats.inProgress || 0),
        resolved: Number(stats.resolved || 0),
        averageResponseMinutes: stats.averageResponseMinutes === null ? null : Math.round(Number(stats.averageResponseMinutes))
      }
    });
  } catch (error) {
    console.error('[Inbox List Error]', error.response?.data?.error?.message || error.message);
    return res.status(500).json({ success: false, message: 'Không tải được hộp thư bình luận.' });
  }
});

function emptyStats() {
  return { total: 0, unanswered: 0, attention: 0, inProgress: 0, resolved: 0, averageResponseMinutes: null };
}

router.get('/assignees', async (req, res) => {
  const pageId = typeof req.query.pageId === 'string' ? req.query.pageId : '';
  if (!isValidPageId(pageId)) return res.status(400).json({ success: false, message: 'Page ID không hợp lệ.' });
  try {
    const pages = await getUserPages(req.user.sub);
    if (!pages.some((page) => String(page.id) === pageId)) return res.status(403).json({ success: false, message: 'Bạn không có quyền truy cập Fanpage này.' });
    const pool = await getPool();
    const result = await pool.request().input('pageId', sql.VarChar(64), pageId).query(`
      SELECT DISTINCT u.facebook_user_id AS id, u.display_name AS name
      FROM dbo.FacebookPages p
      INNER JOIN dbo.FacebookUsers u ON u.facebook_user_id=p.facebook_user_id
      WHERE p.page_id=@pageId ORDER BY u.display_name;
    `);
    return res.json({ success: true, assignees: result.recordset });
  } catch (error) {
    console.error('[Inbox Assignees Error]', error.message);
    return res.status(500).json({ success: false, message: 'Không tải được danh sách người xử lý.' });
  }
});

router.post('/sync', async (req, res) => {
  const requestedPageId = req.body.pageId ? String(req.body.pageId) : '';
  if (requestedPageId && !isValidPageId(requestedPageId)) return res.status(400).json({ success: false, message: 'Page ID không hợp lệ.' });
  try {
    const pages = await getUserPages(req.user.sub);
    const pagesToSync = requestedPageId ? pages.filter((page) => String(page.id) === requestedPageId) : pages;
    if (requestedPageId && !pagesToSync.length) return res.status(403).json({ success: false, message: 'Bạn không có quyền truy cập Fanpage này.' });
    if (!pagesToSync.length) return res.status(409).json({ success: false, message: 'Chưa có Fanpage được kết nối.' });
    await ensureInboxSchema();
    const pool = await getPool();
    const results = [];
    for (const page of pagesToSync) {
      const accessToken = await getFacebookPageAccessToken(page.id);
      const count = await syncPageComments(page, accessToken, pool);
      results.push({ pageId: page.id, pageName: page.name, synced: count });
    }
    return res.json({ success: true, pages: results, synced: results.reduce((sum, item) => sum + item.synced, 0) });
  } catch (error) {
    const graphError = error.response?.data?.error;
    const graphMessage = graphError?.message;
    const missingReadPermission = graphError?.code === 10 || graphError?.code === 200
      || /pages_read_user_content|Page Public Content Access/i.test(graphMessage || '');
    console.error('[Inbox Sync Error]', graphMessage || error.message);
    return res.status(error.response ? 502 : 500).json({
      success: false,
      message: missingReadPermission
        ? 'Meta chưa cấp quyền đọc bình luận cho ứng dụng. Cần Advanced Access cho pages_read_user_content hoặc bật Page Public Content Access trong Meta Developer; sau đó đăng nhập lại để đồng bộ.'
        : graphMessage
          ? `Facebook không cho phép đồng bộ bình luận: ${graphMessage}`
        : 'Không đồng bộ được bình luận. Hãy kiểm tra kết nối Fanpage và thử lại.'
    });
  }
});

router.patch('/comments/:commentId', async (req, res) => {
  const commentId = String(req.params.commentId || '');
  if (!commentId || commentId.length > 64) return res.status(400).json({ success: false, message: 'Mã bình luận không hợp lệ.' });
  const hasStatus = Object.prototype.hasOwnProperty.call(req.body, 'status');
  const hasAssignee = Object.prototype.hasOwnProperty.call(req.body, 'assigneeUserId');
  if (!hasStatus && !hasAssignee) return res.status(400).json({ success: false, message: 'Không có thay đổi cần lưu.' });
  const status = req.body.status;
  if (hasStatus && !['open', 'in_progress', 'resolved'].includes(status)) return res.status(400).json({ success: false, message: 'Trạng thái không hợp lệ.' });
  try {
    await ensureInboxSchema();
    const { comment } = await findAccessibleComment(req.user.sub, commentId);
    if (!comment) return res.status(404).json({ success: false, message: 'Không tìm thấy bình luận trong Fanpage đã kết nối.' });
    const request = (await getPool()).request()
      .input('pageId', sql.VarChar(64), comment.page_id)
      .input('commentId', sql.VarChar(64), commentId);
    const assignments = [];
    if (hasStatus) {
      request.input('status', sql.VarChar(20), status);
      assignments.push('status=@status');
    }
    if (hasAssignee) {
      const assigneeId = req.body.assigneeUserId ? String(req.body.assigneeUserId) : null;
      if (assigneeId && assigneeId.length > 64) return res.status(400).json({ success: false, message: 'Người xử lý không hợp lệ.' });
      if (assigneeId) {
        const eligible = await getPool().then((pool) => pool.request()
          .input('pageId', sql.VarChar(64), comment.page_id)
          .input('assigneeId', sql.VarChar(64), assigneeId)
          .query('SELECT TOP (1) 1 AS eligible FROM dbo.FacebookPages WHERE page_id=@pageId AND facebook_user_id=@assigneeId'));
        if (!eligible.recordset.length) return res.status(400).json({ success: false, message: 'Người xử lý chưa kết nối Fanpage này.' });
      }
      request.input('assigneeId', sql.VarChar(64), assigneeId);
      assignments.push('assigned_to_user_id=@assigneeId');
    }
    await request.query(`UPDATE dbo.FacebookInboxComments SET ${assignments.join(', ')}, last_synced_at=SYSUTCDATETIME() WHERE page_id=@pageId AND comment_id=@commentId`);
    return res.json({ success: true });
  } catch (error) {
    console.error('[Inbox Update Error]', error.message);
    return res.status(500).json({ success: false, message: 'Không cập nhật được bình luận.' });
  }
});

router.post('/comments/:commentId/replies', async (req, res) => {
  const commentId = String(req.params.commentId || '');
  const message = typeof req.body.message === 'string' ? req.body.message.trim() : '';
  if (!commentId || commentId.length > 64) return res.status(400).json({ success: false, message: 'Mã bình luận không hợp lệ.' });
  if (!message || message.length > 8000) return res.status(400).json({ success: false, message: 'Nội dung phản hồi phải có từ 1 đến 8000 ký tự.' });
  try {
    await ensureInboxSchema();
    const { comment } = await findAccessibleComment(req.user.sub, commentId);
    if (!comment) return res.status(404).json({ success: false, message: 'Không tìm thấy bình luận trong Fanpage đã kết nối.' });
    const accessToken = await getFacebookPageAccessToken(comment.page_id);
    const body = new URLSearchParams({ message, access_token: accessToken });
    const graphResponse = await axios.post(`https://graph.facebook.com/${graphVersion}/${encodeURIComponent(commentId)}/comments`, body, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 20000
    });
    await (await getPool()).request()
      .input('pageId', sql.VarChar(64), comment.page_id)
      .input('commentId', sql.VarChar(64), commentId)
      .query(`UPDATE dbo.FacebookInboxComments SET status='resolved', reply_count=reply_count+1,
        first_reply_at=COALESCE(first_reply_at,SYSUTCDATETIME()), last_synced_at=SYSUTCDATETIME()
        WHERE page_id=@pageId AND comment_id=@commentId`);
    return res.json({ success: true, replyId: graphResponse.data.id });
  } catch (error) {
    const graphError = error.response?.data?.error;
    const graphMessage = graphError?.message;
    const missingReplyPermission = graphError?.code === 10 || graphError?.code === 200
      || /pages_manage_engagement/i.test(graphMessage || '');
    console.error('[Inbox Reply Error]', graphMessage || error.message);
    return res.status(error.response ? 502 : 500).json({
      success: false,
      message: missingReplyPermission
        ? 'Meta chưa cấp quyền trả lời bình luận cho ứng dụng. Cần Advanced Access cho pages_manage_engagement; sau đó đăng nhập lại để gửi phản hồi.'
        : graphMessage
          ? `Facebook từ chối gửi phản hồi: ${graphMessage}`
        : 'Không gửi được phản hồi. Vui lòng thử lại.'
    });
  }
});

module.exports = router;