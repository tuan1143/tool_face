import axios from 'axios';

const API_BASE_URL = 'http://localhost:5000/api';

export const inboxApi = {
  list: async (pageId, filter) => {
    const params = { filter };
    if (pageId && pageId !== 'all') params.pageId = pageId;
    const response = await axios.get(`${API_BASE_URL}/inbox/comments`, { params });
    return response.data;
  },

  sync: async (pageId) => {
    const response = await axios.post(`${API_BASE_URL}/inbox/sync`, pageId ? { pageId } : {});
    return response.data;
  },

  assignees: async (pageId) => {
    const response = await axios.get(`${API_BASE_URL}/inbox/assignees`, { params: { pageId } });
    return response.data;
  },

  update: async (commentId, changes) => {
    const response = await axios.patch(`${API_BASE_URL}/inbox/comments/${encodeURIComponent(commentId)}`, changes);
    return response.data;
  },

  reply: async (commentId, message) => {
    const response = await axios.post(`${API_BASE_URL}/inbox/comments/${encodeURIComponent(commentId)}/replies`, { message });
    return response.data;
  }
};

export default inboxApi;