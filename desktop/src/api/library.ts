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
    const result = await invokeApi<DeleteBookResult & { cleanup_pending?: boolean }>('delete_book', { bookId });
    return { status: 'success', book_id: bookId, cleanup_pending: result.cleanup_pending };
}
