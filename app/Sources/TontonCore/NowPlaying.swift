import Foundation

/// What a music player on this Mac is playing, for the notch's Music mode. Read on this Mac and kept there: nothing about
/// it goes to the relay, and none of it is logged.
public struct NowPlaying: Equatable, Sendable {
    /// The player's bundle id, `com.spotify.client`.
    public let app: String
    public let title: String
    public let artist: String
    public let album: String
    public let isPlaying: Bool
    /// In seconds, when the player says.
    public let duration: TimeInterval?
    /// Where the track was at `positionDate`, in seconds.
    public let position: TimeInterval?
    /// When `position` was read: the position now is further on by the time since, while it plays.
    public let positionDate: Date
    /// The player's own id for the track (`spotify:track:…`): two tracks can have the same name.
    public let trackId: String?
    /// Where the player says the cover is.
    public let artworkURL: URL?
    /// The player's own volume, from 0 to 100.
    public let volume: Int?
    public let shuffling: Bool?
    public let repeating: Bool?

    public init(
        app: String, title: String, artist: String, album: String, isPlaying: Bool, duration: TimeInterval? = nil,
        position: TimeInterval? = nil, positionDate: Date = Date(), trackId: String? = nil, artworkURL: URL? = nil,
        volume: Int? = nil, shuffling: Bool? = nil, repeating: Bool? = nil
    ) {
        self.app = app
        self.title = title
        self.artist = artist
        self.album = album
        self.isPlaying = isPlaying
        self.duration = duration
        self.position = position
        self.positionDate = positionDate
        self.trackId = trackId
        self.artworkURL = artworkURL
        self.volume = volume
        self.shuffling = shuffling
        self.repeating = repeating
    }
}
