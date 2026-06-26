// Content Script - DOM-based operations for linux.do
// Navigates pages, extracts data from DOM, interacts with composer

(function () {
  'use strict';

  // ========== Page Load Handler ==========

  function onPageReady() {
    // No pending actions needed - background sends execute after navigation
  }

  if (document.readyState === 'complete') {
    onPageReady();
  } else {
    window.addEventListener('load', onPageReady);
  }

  // ========== Request Router ==========

  async function executeRequest(req) {
    try {
      let data;
      switch (req.type) {
        case 'getLatestTopics':
          data = extractLatestTopics();
          break;
        case 'getTopicDetail':
          data = extractTopicDetail();
          break;
        case 'postReply':
          data = await postReplyViaDOM(req.content, req.replyToPostNumber);
          break;
        case 'getNotifications':
          data = extractNotifications();
          break;
        case 'getCategories':
          data = extractCategories();
          break;
        case 'getCurrentUser':
          data = extractCurrentUser();
          break;
        case 'ping':
          data = { ok: true, url: window.location.href };
          break;
        default:
          throw new Error('Unknown type: ' + req.type);
      }
      chrome.runtime.sendMessage({ requestId: req.requestId, data });
    } catch (err) {
      chrome.runtime.sendMessage({ requestId: req.requestId, error: err.message });
    }
  }

  // ========== Message Listener ==========

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    switch (request.action) {
      case 'execute':
        executeRequest({
          requestId: request.requestId,
          type: request.type,
          content: request.content,
          replyToPostNumber: request.replyToPostNumber
        }).catch(() => {});
        sendResponse({ ok: true });
        return true;
    }
  });

  // ========== DOM Extraction: Latest Topics ==========

  function extractLatestTopics() {
    const topicRows = document.querySelectorAll('[data-topic-id]');
    const topics = Array.from(topicRows).map(row => {
      const postsMap = row.querySelector('.posts-map');
      return {
        id: parseInt(row.dataset.topicId, 10),
        title: row.querySelector('.title a')?.textContent?.trim() || '',
        category_id: parseInt(row.closest('[data-category-id]')?.dataset?.categoryId, 10) || 0,
        posts_count: parseInt(postsMap?.dataset?.postsCount, 10) || 0,
        replyCount: parseInt(postsMap?.dataset?.postsCount, 10) || 0,
        pinned: !!row.closest('.pinned')
      };
    });
    return { topic_list: { topics } };
  }

  // ========== DOM Extraction: Topic Detail ==========

  function extractTopicDetail() {
    const titleEl = document.querySelector('.topic-title');
    const title = titleEl?.textContent?.trim() || '';

    const postEls = document.querySelectorAll('.topic-post');
    const posts = Array.from(postEls).map(post => {
      const cooked = post.querySelector('.cooked');
      return {
        id: parseInt(post.dataset.postId, 10) || 0,
        post_number: parseInt(post.dataset.postNumber, 10) || 0,
        cooked: cooked?.innerHTML || '',
        plain: cooked?.textContent?.trim() || ''
      };
    });

    return (() => {
      const replyBtn = findReplyButton();
      const closedEl = document.querySelector('.topic-status .closed, .topic-status .archived');
      return {
        title,
        post_stream: { posts },
        commentable: !!replyBtn,
        commentableReason: replyBtn ? '' : (closedEl ? '话题已关闭/归档' : '无法回复（无回复按钮）')
      };
    })();
  }

  // ========== DOM Extraction: Notifications ==========

  function extractNotifications() {
    const items = document.querySelectorAll('.notification-item');
    const notifications = Array.from(items).map(item => ({
      id: parseInt(item.dataset.notificationId, 10) || 0,
      notification_type: parseInt(item.dataset.notificationType, 10) || 0,
      topic_id: parseInt(item.dataset.topicId, 10) || 0,
      post_number: parseInt(item.dataset.postNumber, 10) || 0,
      data: {
        original_text: item.querySelector('.excerpt')?.textContent?.trim() || ''
      }
    }));
    return { notifications };
  }

  // ========== DOM Extraction: Categories ==========

  function extractCategories() {
    const catEls = document.querySelectorAll('.category-list-item, .category-box');
    const categories = Array.from(catEls).map(cat => ({
      id: parseInt(cat.dataset.categoryId, 10) || 0,
      slug: cat.dataset.categorySlug || '',
      name: cat.querySelector('.category-name')?.textContent?.trim() || '',
      topic_count: parseInt(cat.querySelector('.topic-count')?.textContent, 10) || 0,
      is_uncategorized: cat.classList.contains('uncategorized')
    }));
    return { category_list: { categories } };
  }

  // ========== DOM Extraction: Current User ==========

  function extractCurrentUser() {
    const userLink = document.querySelector('a[data-user-card]');
    return {
      user: {
        username: userLink?.getAttribute('data-user-card') || ''
      }
    };
  }

  // ========== DOM Post Reply ==========

  async function postReplyViaDOM(content, replyToPostNumber) {
    // Scroll to bottom to ensure reply button is visible
    window.scrollTo(0, document.body.scrollHeight);

    // Click reply button - specific post or topic-level
    let replyBtn;
    if (replyToPostNumber) {
      // Reply to a specific post number
      const targetPost = document.querySelector(`.topic-post[data-post-number="${replyToPostNumber}"]`);
      if (targetPost) {
        replyBtn = targetPost.querySelector('.post-controls .reply')
                || targetPost.querySelector('[data-action="reply"]');
        if (replyBtn) replyBtn.scrollIntoView();
      }
    }
    // Fallback: topic-level reply button
    if (!replyBtn) {
      replyBtn = findReplyButton();
    }
    if (!replyBtn) throw new Error('找不到回复按钮');

    replyBtn.click();

    // Wait for composer to open
    const textarea = await waitForElement('.d-editor-input', 15000);
    if (!textarea) throw new Error('编辑器未出现');

    // Fill content
    textarea.value = content;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));

    // Wait briefly for Discourse to register the input
    await sleep(800);

    // Click submit button
    const submitBtn = document.querySelector('#reply-controls .btn-primary:not(.cancel)')
                   || document.querySelector('.save-or-cancel .btn-primary');
    if (!submitBtn) throw new Error('找不到提交按钮');

    submitBtn.click();

    // Verify: wait for composer to close (indicates post was submitted)
    const composerClosed = await waitForElementRemoval('.d-editor-input', 10000);
    if (!composerClosed) {
      // Check if there's an error message
      const errorEl = document.querySelector('.popup-tip, .alert.alert-error, #dialog-holder .dialog-body');
      const errorMsg = errorEl?.textContent?.trim() || '编辑器未关闭，可能提交失败';
      throw new Error(errorMsg);
    }

    // Extra wait for the post to appear in the topic
    await sleep(2000);

    return { success: true };
  }

  // ========== Helpers ==========

  function findReplyButton() {
    // Discourse has multiple possible reply buttons
    return document.querySelector('#topic-footer-buttons .btn-primary')
        || document.querySelector('.post-controls .reply')
        || document.querySelector('button.create')
        || document.querySelector('[data-action="reply"]');
  }

  function waitForElement(selector, timeoutMs) {
    return new Promise(resolve => {
      const el = document.querySelector(selector);
      if (el) { resolve(el); return; }

      const observer = new MutationObserver(() => {
        const found = document.querySelector(selector);
        if (found) {
          observer.disconnect();
          resolve(found);
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });

      setTimeout(() => {
        observer.disconnect();
        resolve(null);
      }, timeoutMs);
    });
  }

  function waitForElementRemoval(selector, timeoutMs) {
    return new Promise(resolve => {
      const el = document.querySelector(selector);
      if (!el) { resolve(true); return; }

      const observer = new MutationObserver(() => {
        if (!document.querySelector(selector)) {
          observer.disconnect();
          resolve(true);
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });

      setTimeout(() => {
        observer.disconnect();
        resolve(null); // null = timeout, element still exists
      }, timeoutMs);
    });
  }

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  console.log('[LinuxDoHelper] Content script (DOM mode) loaded');
})();