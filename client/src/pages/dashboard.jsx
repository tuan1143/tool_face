import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowUpRight, CalendarDays, CircleAlert, FileSpreadsheet, PenLine, Send, Sparkles } from 'lucide-react';
import MainLayout from '../components/layout/MainLayout';
import useAuth from '../hooks/useAuth';
import postApi from '../services/postApi';

const statusLabels = {
  pending: 'Chờ đăng',
  publishing: 'Đang đăng',
  published: 'Đã đăng',
  failed: 'Thất bại'
};

export default function DashboardHomePage() {
  const { user } = useAuth();
  const isAuthenticated = Boolean(user);
  const [stats, setStats] = useState({ total: 0, pending: 0, published: 0, failed: 0 });
  const [posts, setPosts] = useState([]);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([postApi.getStats(), postApi.getPostsList({ limit: 5 })])
      .then(([summary, result]) => {
        setStats(summary.stats || { total: 0, pending: 0, published: 0, failed: 0 });
        setPosts(result.posts || []);
      })
      .catch((requestError) => {
        const unauthorized = requestError?.response?.status === 401 || requestError?.response?.status === 403;
        if (unauthorized) {
          setStats({ total: 0, pending: 0, published: 0, failed: 0 });
          setPosts([]);
          return;
        }
        setError(requestError.response?.data?.message || 'Không thể tải dữ liệu bảng tin.');
      });
  }, []);

  const cards = [
    { label: 'Bài đăng', value: stats.total, note: 'Trong workspace của bạn', icon: Send },
    { label: 'Đang chờ', value: stats.pending, note: 'Chờ tới lịch đăng', icon: CalendarDays },
    { label: 'Đã xuất bản', value: stats.published, note: 'Đã đăng thành công', icon: PenLine },
    { label: 'Cần kiểm tra', value: stats.failed, note: 'Bài đăng thất bại', icon: CircleAlert }
  ];
  const publishedPercent = stats.total ? Math.round((stats.published / stats.total) * 100) : 0;

  return (
    <MainLayout title="Bảng tin">
      <section className="home-hero">
        <div className="home-hero-copy">
          <div className="home-eyebrow"><span /> Không gian xuất bản</div>
          <h2>Giữ nhịp nội dung, <em>mọi ngày.</em></h2>
          <p>Soạn bài, lên lịch và theo dõi hiệu quả trên các Fanpage đã kết nối.</p>
          <div className="home-banner-actions">
            <Link className="button home-primary-action" href={isAuthenticated ? '/post-planner/compose' : '/login'}><PenLine size={15} /> {isAuthenticated ? 'Viết bài mới' : 'Đăng nhập để viết'}</Link>
            <Link className="button home-secondary-action" href={isAuthenticated ? '/post-planner/bulk-upload' : '/login'}><FileSpreadsheet size={15} /> {isAuthenticated ? 'Tải lịch Excel' : 'Đăng nhập để tải'}</Link>
          </div>
        </div>
        <div className="home-publishing-progress">
          <div className="home-progress-heading"><span>Tiến độ xuất bản</span><strong>{publishedPercent}<small>%</small></strong></div>
          <div className="home-progress-track" role="progressbar" aria-label="Tỷ lệ bài đăng đã xuất bản" aria-valuemin="0" aria-valuemax="100" aria-valuenow={publishedPercent}>
            <span style={{ width: `${publishedPercent}%` }} />
          </div>
          <div className="home-progress-stats">
            <span><i className="is-published" />{stats.published} đã đăng</span>
            <span><i className="is-pending" />{stats.pending} chờ đăng</span>
            <span><i className="is-failed" />{stats.failed} cần xử lý</span>
          </div>
          <Link className="home-progress-link" href="/post-planner/dashboard">Xem báo cáo <ArrowUpRight size={14} /></Link>
        </div>
      </section>
      <section className="metric-grid home-metrics" aria-label="Tổng quan bài đăng">
        {cards.map(({ label, value, note, icon: Icon }, index) => <article className={`panel metric-card home-metric-card home-metric-${index}`} key={label}>
          <div className="home-metric-top"><span className="home-metric-icon"><Icon size={17} /></span><span className="metric-label">{label}</span></div>
          <div className="metric-value">{value}</div>
          <div className="metric-foot">{note}</div>
        </article>)}
      </section>
      {error && <div className="notice home-notice" role="alert">{error}</div>}
      {!isAuthenticated && <div className="notice home-notice">Bạn đang ở chế độ xem trước. Đăng nhập để quản lý và lên lịch bài đăng.</div>}
      <div className="home-columns">
        <section className="panel home-panel"><div className="panel-heading"><div><span className="home-section-kicker">Hoạt động</span><h2>Bài đăng gần đây</h2></div><Link className="home-text-link" href="/post-planner/list">Xem tất cả <ArrowUpRight size={14} /></Link></div><div className="panel-body home-post-list">
          {posts.length ? posts.map((post) => <div className="post-row home-post-row" key={post.id}><div className="home-post-copy"><strong>{post.content || 'Chưa có nội dung'}</strong><small>#{post.id} <span /> {post.scheduled_at ? new Date(post.scheduled_at).toLocaleString('vi-VN') : 'Chưa đặt lịch'}</small></div><span className={`status-pill ${post.status || 'pending'}`}>{statusLabels[post.status] || 'Chờ đăng'}</span></div>) : <div className="empty-state">{isAuthenticated ? 'Chưa có bài đăng gần đây.' : 'Đăng nhập để xem bài đăng trong workspace.'}</div>}
        </div></section>
        <section className="panel home-panel"><div className="panel-heading"><div><span className="home-section-kicker">Lối tắt</span><h2>Đi đến nhanh</h2></div></div><div className="panel-body quick-links home-quick-links">
          <Link className="quick-link home-quick-link" href="/post-planner/calendar"><span className="quick-icon"><CalendarDays size={17} /></span><span><strong>Lịch đăng</strong><small>Xem và sắp xếp bài theo ngày</small></span><ArrowUpRight size={15} className="home-quick-arrow" /></Link>
          <Link className="quick-link home-quick-link" href="/ai-studio"><span className="quick-icon"><Sparkles size={17} /></span><span><strong>AI Studio</strong><small>Sáng tạo nội dung mới</small></span><ArrowUpRight size={15} className="home-quick-arrow" /></Link>
          <Link className="quick-link home-quick-link" href="/channels"><span className="quick-icon"><Send size={17} /></span><span><strong>Kênh đăng</strong><small>Quản lý Facebook Pages</small></span><ArrowUpRight size={15} className="home-quick-arrow" /></Link>
          <Link className="quick-link home-quick-link" href="/post-planner/bulk-upload"><span className="quick-icon"><FileSpreadsheet size={17} /></span><span><strong>Tải hàng loạt</strong><small>Nhập lịch từ Excel</small></span><ArrowUpRight size={15} className="home-quick-arrow" /></Link>
        </div></section>
      </div>
    </MainLayout>
  );
}
