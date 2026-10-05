import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  AlertCircle,
  ArrowUpRight,
  Check,
  CheckCircle2,
  Clock3,
  MessageCircle,
  RefreshCw,
  Send,
  Sparkles
} from 'lucide-react';
import MainLayout from '../../components/layout/MainLayout';
import useAuth from '../../hooks/useAuth';
import aiApi from '../../services/aiApi';
import inboxApi from '../../services/inboxApi';

const filters = [
  { id: 'unanswered', label: 'Chưa trả lời' },
  { id: 'attention', label: 'Cần chú ý' },
  { id: 'in_progress', label: 'Đang xử lý' },
  { id: 'resolved', label: 'Đã xử lý' },
  { id: 'all', label: 'Tất cả' }
];

const replyTemplates = [
  { id: 'thanks', label: 'Cảm ơn', text: 'Cảm ơn bạn đã quan tâm và để lại bình luận. Bên mình sẽ hỗ trợ bạn ngay nhé!' },
  { id: 'inbox', label: 'Mời nhắn tin', text: 'Cảm ơn bạn! Bạn vui lòng nhắn tin trực tiếp cho Fanpage để bên mình hỗ trợ chi tiết hơn nhé.' },
  { id: 'checking', label: 'Đang kiểm tra', text: 'Bên mình đã ghi nhận thông tin và đang kiểm tra. Sẽ phản hồi bạn sớm nhất có thể nhé!' }
];

const replyTones = [
  { id: 'friendly', label: 'Thân thiện', instruction: 'giọng thân thiện, tự nhiên' },
  { id: 'professional', label: 'Chuyên nghiệp', instruction: 'giọng chuyên nghiệp, rõ ràng' },
  { id: 'concise', label: 'Ngắn gọn', instruction: 'giọng ngắn gọn, trực tiếp' }
];

const emptyStats = { total: 0, unanswered: 0, attention: 0, inProgress: 0, resolved: 0, averageResponseMinutes: null };

function isAttention(comment) {
  return comment.replyCount === 0 && comment.status !== 'resolved'
    && Date.now() - new Date(comment.createdAt).getTime() >= 24 * 60 * 60 * 1000;
}

function statusFor(comment) {
  if (comment.status === 'resolved') return { label: 'Đã xử lý', className: 'is-resolved' };
  if (comment.status === 'in_progress') return { label: 'Đang xử lý', className: 'is-progress' };
  if (comment.replyCount > 0) return { label: 'Có phản hồi', className: 'is-progress' };
  if (isAttention(comment)) return { label: 'Cần chú ý', className: 'is-attention' };
  return { label: 'Chưa trả lời', className: 'is-open' };
}

function formatResponseTime(minutes) {
  if (minutes === null || minutes === undefined) return 'Chưa có dữ liệu';
  if (minutes < 60) return `${minutes} phút`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours} giờ ${remainingMinutes} phút` : `${hours} giờ`;
}

export default function InboxPage() {
  const { user } = useAuth();
  const isAuthenticated = Boolean(user);
  const [channels, setChannels] = useState([]);
  const [pageId, setPageId] = useState('all');
  const [filter, setFilter] = useState('unanswered');
  const [comments, setComments] = useState([]);
  const [stats, setStats] = useState(emptyStats);
  const [selectedId, setSelectedId] = useState('');
  const [assignees, setAssignees] = useState([]);
  const [replyDraft, setReplyDraft] = useState('');
  const [replyTone, setReplyTone] = useState('friendly');
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [sending, setSending] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    if (!isAuthenticated) {
      setChannels([]);
      setComments([]);
      setStats(emptyStats);
      setLoading(false);
      return undefined;
    }
    let active = true;
    setLoading(true);
    setError('');
    inboxApi.list(pageId, filter)
      .then((result) => {
        if (!active) return;
        const nextComments = result.comments || [];
        setChannels(result.pages || []);
        setComments(nextComments);
        setStats(result.stats || emptyStats);
        setSelectedId((current) => nextComments.some((comment) => comment.commentId === current)
          ? current
          : nextComments[0]?.commentId || '');
      })
      .catch((requestError) => {
        if (active) setError(requestError.response?.data?.message || 'Không tải được hộp thư bình luận.');
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [filter, isAuthenticated, pageId, reloadKey]);

  const selected = comments.find((comment) => comment.commentId === selectedId) || null;

  useEffect(() => {
    setReplyDraft('');
    if (!selected) {
      setAssignees([]);
      return undefined;
    }
    let active = true;
    inboxApi.assignees(selected.pageId)
      .then((result) => { if (active) setAssignees(result.assignees || []); })
      .catch(() => { if (active) setAssignees([]); });
    return () => { active = false; };
  }, [selected?.commentId, selected?.pageId]);

  const refresh = () => setReloadKey((value) => value + 1);

  const handleSync = async () => {
    setSyncing(true);
    setError('');
    setNotice('');
    try {
      const result = await inboxApi.sync(pageId === 'all' ? '' : pageId);
      const pageCount = result.pages?.length || 0;
      setNotice(`Đã đồng bộ ${result.synced || 0} bình luận từ ${pageCount} Fanpage.`);
      refresh();
    } catch (requestError) {
      setError(requestError.response?.data?.message || 'Không đồng bộ được bình luận.');
    } finally {
      setSyncing(false);
    }
  };

  const updateComment = async (changes, successMessage) => {
    if (!selected) return;
    setError('');
    try {
      await inboxApi.update(selected.commentId, changes);
      setNotice(successMessage);
      refresh();
    } catch (requestError) {
      setError(requestError.response?.data?.message || 'Không cập nhật được bình luận.');
    }
  };

  const handleReply = async () => {
    if (!selected || !replyDraft.trim()) return;
    setSending(true);
    setError('');
    try {
      await inboxApi.reply(selected.commentId, replyDraft.trim());
      setReplyDraft('');
      setNotice('Đã gửi phản hồi lên Fanpage.');
      refresh();
    } catch (requestError) {
      setError(requestError.response?.data?.message || 'Không gửi được phản hồi.');
    } finally {
      setSending(false);
    }
  };

  const handleAiDraft = async () => {
    if (!selected) return;
    setDrafting(true);
    setError('');
    try {
      const prompt = [
        `Hãy soạn một bản nháp trả lời bình luận Facebook bằng tiếng Việt, ${replyTones.find((tone) => tone.id === replyTone)?.instruction || 'giọng thân thiện'}.`,
        'Không tự gửi câu trả lời. Không bịa giá, chính sách, tồn kho hoặc thông tin mà ngữ cảnh không có.',
        'Chỉ trả về nội dung câu trả lời, không thêm lời dẫn.',
        `Fanpage: ${selected.pageName}`,
        `Nội dung bài đăng: ${selected.postMessage || '(không có)'}`,
        `Bình luận cần trả lời: ${selected.commentText}`
      ].join('\n');
      const result = await aiApi.chat(prompt);
      setReplyDraft(result.reply || '');
    } catch (requestError) {
      setError(requestError.response?.data?.message || 'AI chưa tạo được bản nháp.');
    } finally {
      setDrafting(false);
    }
  };

  const handleAssignee = (event) => {
    updateComment({ assigneeUserId: event.target.value || null }, 'Đã cập nhật người xử lý.');
  };

  const statCards = [
    { label: 'Chưa trả lời', value: stats.unanswered, icon: MessageCircle, tone: 'open' },
    { label: 'Cần chú ý · trên 24 giờ', value: stats.attention, icon: AlertCircle, tone: 'attention' },
    { label: 'Đang xử lý', value: stats.inProgress, icon: Clock3, tone: 'progress' },
    { label: 'Phản hồi trung bình', value: formatResponseTime(stats.averageResponseMinutes), icon: CheckCircle2, tone: 'resolved' }
  ];

  return (
    <MainLayout
      title="Hộp thư bình luận"
      actions={<button className="button button-secondary" type="button" onClick={handleSync} disabled={!isAuthenticated || syncing}>
        <RefreshCw size={15} className={syncing ? 'inbox-spin' : ''} /> {syncing ? 'Đang đồng bộ' : 'Đồng bộ bình luận'}
      </button>}
    >
      {error && <div className="notice inbox-notice" role="alert">{error}</div>}
      {notice && <div className="inbox-success" role="status"><Check size={15} />{notice}</div>}
      {!isAuthenticated && <div className="notice inbox-notice">Đăng nhập Facebook để xem và trả lời bình luận trên các Fanpage đã kết nối.</div>}

      <section className="inbox-stat-grid" aria-label="Thống kê hộp thư">
        {statCards.map(({ label, value, icon: Icon, tone }) => <article className={`panel inbox-stat inbox-stat-${tone}`} key={label}>
          <span className="inbox-stat-icon"><Icon size={17} /></span>
          <div><span>{label}</span><strong>{loading ? '—' : value}</strong></div>
        </article>)}
      </section>

      <div className="inbox-toolbar">
        <div className="inbox-filters" role="tablist" aria-label="Lọc bình luận">
          {filters.map((item) => <button
            className={`inbox-filter${filter === item.id ? ' is-selected' : ''}`}
            key={item.id}
            type="button"
            role="tab"
            aria-selected={filter === item.id}
            onClick={() => setFilter(item.id)}
          >{item.label}</button>)}
        </div>
        <label className="inbox-page-filter">
          <span>Fanpage</span>
          <select className="field" value={pageId} onChange={(event) => setPageId(event.target.value)} disabled={!isAuthenticated || channels.length === 0}>
            <option value="all">Tất cả Fanpage</option>
            {channels.map((channel) => <option value={channel.id} key={channel.id}>{channel.name}</option>)}
          </select>
        </label>
      </div>

      <section className="inbox-layout">
        <div className="panel inbox-list-panel">
          <div className="inbox-list-heading"><div><strong>Bình luận</strong><span>{comments.length} gần đây</span></div><button className="icon-button" type="button" aria-label="Làm mới danh sách" onClick={refresh} disabled={!isAuthenticated || loading}><RefreshCw size={15} /></button></div>
          <div className="inbox-thread-list" aria-busy={loading}>
            {loading ? <div className="inbox-empty">Đang tải bình luận…</div> : comments.length ? comments.map((comment) => {
              const status = statusFor(comment);
              return <button className={`inbox-thread${selectedId === comment.commentId ? ' is-selected' : ''}`} key={`${comment.pageId}-${comment.commentId}`} type="button" onClick={() => setSelectedId(comment.commentId)}>
                <span className="inbox-thread-top"><strong>{comment.commenterName}</strong><time>{new Date(comment.createdAt).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' })}</time></span>
                <span className="inbox-thread-page">{comment.pageName}</span>
                <span className="inbox-thread-preview">{comment.commentText}</span>
                <span className={`inbox-status ${status.className}`}>{status.label}</span>
              </button>;
            }) : <div className="inbox-empty"><MessageCircle size={22} /><strong>Chưa có bình luận</strong><span>{isAuthenticated ? 'Đồng bộ Fanpage để tải các bình luận mới nhất.' : 'Đăng nhập để bắt đầu.'}</span></div>}
          </div>
        </div>

        <div className="panel inbox-detail-panel">
          {selected ? <>
            <div className="inbox-detail-heading">
              <div><span className="inbox-detail-kicker">{selected.pageName}</span><h2>{selected.commenterName}</h2></div>
              {selected.permalinkUrl && <a className="inbox-post-link" href={selected.permalinkUrl} target="_blank" rel="noreferrer">Mở bài đăng <ArrowUpRight size={14} /></a>}
            </div>
            <div className="inbox-conversation">
              <div className="inbox-post-context"><span>Bài viết</span><p>{selected.postMessage || 'Không có nội dung bài viết.'}</p></div>
              <article className="inbox-comment-bubble">
                <div className="inbox-comment-meta"><strong>{selected.commenterName}</strong><time>{new Date(selected.createdAt).toLocaleString('vi-VN')}</time></div>
                <p>{selected.commentText}</p>
              </article>
              {selected.replyCount > 0 && <div className="inbox-reply-context"><CheckCircle2 size={15} /> Đã có {selected.replyCount} phản hồi trên Facebook</div>}
            </div>

            <div className="inbox-assignment-row">
              <label><span>Người xử lý</span><select className="field" value={selected.assigneeUserId || ''} onChange={handleAssignee}>
                <option value="">Chưa phân công</option>
                {assignees.map((assignee) => <option value={assignee.id} key={assignee.id}>{assignee.name}{String(assignee.id) === String(user?.id) ? ' (Bạn)' : ''}</option>)}
              </select></label>
              <div className="inbox-detail-actions">
                {selected.status === 'resolved'
                  ? <button className="button button-secondary" type="button" onClick={() => updateComment({ status: 'in_progress' }, 'Đã mở lại để tiếp tục xử lý.')}><RefreshCw size={14} /> Mở lại</button>
                  : <button className="button button-secondary" type="button" onClick={() => updateComment({ status: 'resolved' }, 'Đã đánh dấu hoàn tất.')}><CheckCircle2 size={14} /> Đánh dấu hoàn tất</button>}
                {selected.status === 'open' && <button className="button button-quiet" type="button" onClick={() => updateComment({ status: 'in_progress' }, 'Đã chuyển sang đang xử lý.')}><Clock3 size={14} /> Nhận xử lý</button>}
              </div>
            </div>

            <div className="inbox-reply-box">
              <div className="inbox-reply-tools">
                <label className="inbox-template-select"><span>Mẫu trả lời</span><select className="field" value="" onChange={(event) => {
                  const template = replyTemplates.find((item) => item.id === event.target.value);
                  if (template) setReplyDraft(template.text);
                }}>
                  <option value="">Chọn mẫu…</option>
                  {replyTemplates.map((template) => <option value={template.id} key={template.id}>{template.label}</option>)}
                </select></label>
                <label className="inbox-tone-select"><span>Giọng AI</span><select className="field" value={replyTone} onChange={(event) => setReplyTone(event.target.value)}>
                  {replyTones.map((tone) => <option value={tone.id} key={tone.id}>{tone.label}</option>)}
                </select></label>
                <button className="button button-quiet" type="button" onClick={handleAiDraft} disabled={drafting}><Sparkles size={14} /> {drafting ? 'Đang soạn' : 'AI soạn nháp'}</button>
              </div>
              <textarea className="field inbox-reply-editor" value={replyDraft} onChange={(event) => setReplyDraft(event.target.value)} maxLength={8000} placeholder="Viết phản hồi…" aria-label="Nội dung phản hồi" />
              <div className="inbox-reply-footer"><span>Bản nháp AI cần được kiểm tra. Chỉ gửi khi bạn xác nhận.</span><button className="button button-primary" type="button" onClick={handleReply} disabled={sending || !replyDraft.trim()}><Send size={14} /> {sending ? 'Đang gửi' : 'Gửi phản hồi'}</button></div>
            </div>
          </> : <div className="inbox-detail-empty"><MessageCircle size={28} /><strong>Chọn một bình luận</strong><span>Nội dung và thao tác xử lý sẽ hiện ở đây.</span></div>}
        </div>
      </section>
      <div className="inbox-permission-note"><AlertCircle size={14} /> Cần cấp quyền Meta <code>pages_read_engagement</code>, <code>pages_read_user_content</code> và <code>pages_manage_engagement</code>. <Link href="/login">Đăng nhập lại để cấp quyền</Link></div>
    </MainLayout>
  );
}