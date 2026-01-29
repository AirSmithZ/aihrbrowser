import type { Message } from '@extension/storage';
import { ACTOR_PROFILES } from '../types/message';
import { memo, useEffect, useState } from 'react';

interface MessageListProps {
  messages: Message[];
  isDarkMode?: boolean;
}

export default memo(function MessageList({ messages, isDarkMode = false }: MessageListProps) {
  return (
    <div className="max-w-full space-y-4">
      {messages.map((message, index) => (
        <MessageBlock
          key={`${message.actor}-${message.timestamp}-${index}`}
          message={message}
          isSameActor={index > 0 ? messages[index - 1].actor === message.actor : false}
          isDarkMode={isDarkMode}
        />
      ))}
    </div>
  );
});

interface MessageBlockProps {
  message: Message;
  isSameActor: boolean;
  isDarkMode?: boolean;
}

function MessageBlock({ message, isSameActor, isDarkMode = false }: MessageBlockProps) {
  // Hooks must be called unconditionally at the top of the component
  const [displayContent, setDisplayContent] = useState(message.content);
  const actorKey = (message.actor || 'system') as keyof typeof ACTOR_PROFILES;
  const actor = ACTOR_PROFILES[actorKey];
  const isProgress = message.content === 'Showing progress...';

  useEffect(() => {
    if (!message.actor) {
      // For unexpected missing actor, just keep whatever content we already have
      return;
    }

    if (isProgress || message.actor === 'user') {
      setDisplayContent(message.content);
      return;
    }

    const text = message.content;
    // Short messages render instantly
    if (text.length <= 8) {
      setDisplayContent(text);
      return;
    }

    let index = 0;
    setDisplayContent('');

    const step = Math.max(1, Math.floor(text.length / 80)); // roughly 60–80 frames
    const interval = window.setInterval(() => {
      index += step;
      if (index >= text.length) {
        setDisplayContent(text);
        window.clearInterval(interval);
      } else {
        setDisplayContent(text.slice(0, index));
      }
    }, 16); // ~60fps

    return () => window.clearInterval(interval);
  }, [isProgress, message.actor, message.content]);

  return (
    <div
      className={`flex max-w-full gap-3 ${
        !isSameActor
          ? `mt-4 border-t ${isDarkMode ? 'border-sky-800/50' : 'border-sky-200/50'} pt-4 first:mt-0 first:border-t-0 first:pt-0`
          : ''
      }`}>
      {!isSameActor && (
        <div
          className="flex size-9 shrink-0 items-center justify-center rounded-full shadow-sm"
          style={{ backgroundColor: actor.iconBackground }}>
          <span className="text-lg" aria-hidden="true">
            {'emoji' in actor ? (actor as { emoji: string }).emoji : '💬'}
          </span>
        </div>
      )}
      {isSameActor && <div className="w-8" />}

      <div className="min-w-0 flex-1">
        {!isSameActor && (
          <div className={`mb-1 text-sm font-semibold ${isDarkMode ? 'text-gray-200' : 'text-gray-900'}`}>
            {actor.name}
          </div>
        )}

        <div className="space-y-1">
          <div
            className={`inline-block max-w-full whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-sm shadow-sm ${
              isProgress
                ? isDarkMode
                  ? 'bg-slate-800'
                  : 'bg-gray-100'
                : isDarkMode
                  ? 'bg-slate-800 text-gray-100'
                  : 'bg-white text-gray-800'
            }`}>
            {isProgress ? (
              <div className="flex min-w-[5.5rem] flex-col gap-2">
                <div className="flex items-center gap-1.5">
                  <span
                    className={`text-sm font-medium tracking-wide ${
                      isDarkMode ? 'text-slate-200' : 'text-gray-700'
                    }`}>
                    思考中
                  </span>
                  <span className="flex gap-0.5" aria-hidden="true">
                    {[0, 1, 2].map((i) => (
                      <span
                        key={i}
                        className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                          isDarkMode ? 'bg-sky-400' : 'bg-sky-500'
                        } animate-thinkDot`}
                        style={{ animationDelay: `${i * 0.16}s` }}
                      />
                    ))}
                  </span>
                </div>
                <div
                  className={`h-0.5 w-full overflow-hidden rounded-full ${
                    isDarkMode ? 'bg-slate-600/80' : 'bg-sky-100'
                  }`}>
                  <div
                    className={`h-full w-1/2 rounded-full ${
                      isDarkMode
                        ? 'bg-gradient-to-r from-transparent via-sky-400 to-transparent'
                        : 'bg-gradient-to-r from-transparent via-sky-500 to-transparent'
                    } animate-thinkBar`}
                  />
                </div>
              </div>
            ) : (
              displayContent
            )}
          </div>
          {!isProgress && (
            <div className={`text-right text-xs ${isDarkMode ? 'text-gray-500' : 'text-gray-300'}`}>
              {formatTimestamp(message.timestamp)}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Formats a timestamp (in milliseconds) to a readable time string
 * @param timestamp Unix timestamp in milliseconds
 * @returns Formatted time string
 */
function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();

  // Check if the message is from today
  const isToday = date.toDateString() === now.toDateString();

  // Check if the message is from yesterday
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday = date.toDateString() === yesterday.toDateString();

  // Check if the message is from this year
  const isThisYear = date.getFullYear() === now.getFullYear();

  // Format the time (HH:MM)
  const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  if (isToday) {
    return timeStr; // Just show the time for today's messages
  }

  if (isYesterday) {
    return `Yesterday, ${timeStr}`;
  }

  if (isThisYear) {
    // Show month and day for this year
    return `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${timeStr}`;
  }

  // Show full date for older messages
  return `${date.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' })}, ${timeStr}`;
}
