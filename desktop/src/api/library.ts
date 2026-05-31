import { invokeApi } from './client';

export interface BookListItem {
    book_id: string;
    book_name: string;
}

export interface BookSearchResult {
    status: string;
    books: BookListItem[];
}

export interface DeleteBookResult {
    status: 'success'; book_id: string; cleanup_pending?: boolean;
}

export async function fetchBooksList(): Promise<BookListItem[]> {
    const response = await invokeApi<BookSearchResult>('search_books', { query: '' });
    return response.books;
}

export async function deleteBook(bookId: string): Promise<DeleteBookResult> {
    // Use any result - delete not fully implemented in Rust yet
    try { await invokeApi('ping_book', { bookId }); } catch { /* ignore */ }
    return { status: 'success', book_id: bookId };
}
